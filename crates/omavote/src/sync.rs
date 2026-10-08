//! Chain sync: feeds canonical blocks into the replay engine, caches reduced blocks
//! in SQLite, keeps in-memory snapshots and rolls back to the common ancestor when
//! the node's canonical chain changes (docs/03 §9–§10, docs/13 §5).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::engine::{BlockInput, Engine, EngineConfig};
use omavote_core::json::{parse, to_jcs};
use omavote_core::molecule::OutPoint;
use omavote_core::util::{to_hex, Hash32};

use crate::chain::{MedianWindow, RawBlock};
use crate::rpc::Rpc;
use crate::store::{BlockRow, DaoEvent, Store};
use crate::util::{core_err, now_ms};

/// Where canonical blocks come from (the node in production, a mock in tests).
pub trait Source: Send + Sync {
    fn tip(&self) -> impl Future<Output = Result<u64>> + Send;
    fn block(&self, n: u64) -> impl Future<Output = Result<Option<RawBlock>>> + Send;
    fn hash(&self, n: u64) -> impl Future<Output = Result<Option<Hash32>>> + Send;
    /// Node-reported median time ending at `hash` (cross-check of the local clock).
    fn median_time(&self, hash: &Hash32) -> impl Future<Output = Result<Option<u64>>> + Send;
}

impl Source for Rpc {
    async fn tip(&self) -> Result<u64> {
        self.tip_number().await
    }
    async fn block(&self, n: u64) -> Result<Option<RawBlock>> {
        match self.block_by_number(n).await? {
            Some(v) => Ok(Some(RawBlock::from_rpc(&v)?)),
            None => Ok(None),
        }
    }
    async fn hash(&self, n: u64) -> Result<Option<Hash32>> {
        match self.block_hash(n).await? {
            Some(s) => Ok(Some(crate::util::hash_arg(&s)?)),
            None => Ok(None),
        }
    }
    async fn median_time(&self, hash: &Hash32) -> Result<Option<u64>> {
        Ok(Some(Rpc::median_time(self, &to_hex(hash)).await?))
    }
}

#[derive(Clone, Debug)]
pub struct SyncConfig {
    pub engine: EngineConfig,
    pub batch: usize,
    pub snapshot_every: u64,
    pub snapshots_kept: usize,
    pub poll_interval: Duration,
    /// Compare every computed clock with the node's `get_block_median_time(parent)`.
    pub check_clock: bool,
    /// Stop after this height (verify runs up to a fixed tip).
    pub stop_at: Option<u64>,
    /// Accelerated start: replay from this verified state instead of genesis.
    pub bootstrap: Option<crate::bootstrap::Bootstrap>,
}

impl SyncConfig {
    pub fn new(engine: EngineConfig) -> Self {
        SyncConfig {
            engine,
            batch: 50,
            snapshot_every: 100,
            snapshots_kept: 12,
            poll_interval: Duration::from_millis(1000),
            check_clock: false,
            stop_at: None,
            bootstrap: None,
        }
    }
}

#[derive(Clone)]
struct Snapshot {
    height: u64,
    engine: Engine,
    window: MedianWindow,
}

#[derive(Clone, Debug)]
pub struct ReorgEvent {
    pub at_ms: u64,
    pub old_tip: u64,
    pub fork_height: u64,
    pub depth: u64,
}

pub struct ChainState {
    pub engine: Engine,
    pub window: MedianWindow,
    /// Recent canonical hashes by height (fork search without the database).
    pub hashes: BTreeMap<u64, Hash32>,
    snapshots: Vec<Snapshot>,
    pub node_tip: Option<u64>,
    pub synced: bool,
    pub last_sync_ms: u64,
    pub last_error: Option<String>,
    pub reorgs: Vec<ReorgEvent>,
    pub blocks_applied: u64,
}

const HASHES_KEPT: u64 = 20_000;

impl ChainState {
    pub fn new(cfg: &SyncConfig) -> Self {
        let (engine, window, hashes) = fresh(cfg);
        ChainState {
            engine,
            window,
            hashes,
            snapshots: Vec::new(),
            node_tip: None,
            synced: false,
            last_sync_ms: 0,
            last_error: None,
            reorgs: Vec::new(),
            blocks_applied: 0,
        }
    }

    pub fn tip(&self) -> Option<(u64, Hash32, u64)> {
        self.engine.tip
    }

    fn after_block(&mut self, number: u64, hash: Hash32, timestamp: u64, cfg: &SyncConfig) {
        self.window.push(timestamp);
        self.hashes.insert(number, hash);
        if number >= HASHES_KEPT {
            let cut = number - HASHES_KEPT;
            while let Some((&h, _)) = self.hashes.first_key_value() {
                if h > cut {
                    break;
                }
                self.hashes.pop_first();
            }
        }
        self.blocks_applied += 1;
        if cfg.snapshot_every > 0 && number.is_multiple_of(cfg.snapshot_every) {
            self.snapshots.push(Snapshot { height: number, engine: self.engine.clone(), window: self.window.clone() });
            if self.snapshots.len() > cfg.snapshots_kept {
                self.snapshots.remove(0);
            }
        }
    }

    /// Reduce and apply one raw block; returns the cache row and DAO history events.
    fn apply_raw(&mut self, raw: &RawBlock, cfg: &SyncConfig) -> Result<(BlockRow, Vec<DaoEvent>)> {
        let clock_ms = self.window.clock_for_next(raw.timestamp);
        let net = self.engine.network().clone();
        let reduced = {
            let engine = &self.engine;
            raw.reduce(clock_ms, &net, &|op: &OutPoint| engine.is_tracked(op))
        };
        self.engine.process_block(&reduced).map_err(core_err).with_context(|| format!("block {}", raw.number))?;
        let events = dao_events(&reduced, &net);
        self.after_block(raw.number, raw.hash, raw.timestamp, cfg);
        let body = if reduced.transactions.is_empty() { None } else { Some(to_jcs(&reduced.to_json())) };
        Ok((
            BlockRow { number: raw.number, hash: raw.hash, parent_hash: raw.parent_hash, timestamp: raw.timestamp, clock_ms, body },
            events,
        ))
    }

    /// Re-apply a cached block (startup and reorg replay).
    fn apply_row(&mut self, row: &BlockRow, cfg: &SyncConfig) -> Result<()> {
        let expected = self.window.clock_for_next(row.timestamp);
        if expected != row.clock_ms {
            bail!("cached clock of block {} differs from the recomputed median time", row.number);
        }
        let input = match &row.body {
            Some(b) => BlockInput::from_json(&parse(b.as_bytes()).map_err(core_err)?).map_err(core_err)?,
            None => BlockInput {
                number: row.number,
                hash: row.hash,
                parent_hash: row.parent_hash,
                clock_ms: row.clock_ms,
                transactions: Vec::new(),
            },
        };
        if input.number != row.number || input.hash != row.hash {
            bail!("cached block {} is inconsistent", row.number);
        }
        self.engine.process_block(&input).map_err(core_err).with_context(|| format!("cached block {}", row.number))?;
        self.after_block(row.number, row.hash, row.timestamp, cfg);
        Ok(())
    }
}

/// Engine, clock window and known hashes before the first replayed block: empty for
/// a replay from genesis, the verified bootstrap state otherwise.
fn fresh(cfg: &SyncConfig) -> (Engine, MedianWindow, BTreeMap<u64, Hash32>) {
    let mut engine = Engine::new(cfg.engine.clone());
    let mut hashes = BTreeMap::new();
    let mut window = MedianWindow::new();
    if let Some(b) = &cfg.bootstrap {
        for (h, n, c) in &b.anchors {
            engine.add_known_block(*h, *n, *c);
            hashes.insert(*n, *h);
        }
        engine.bootstrap(b.height, b.hash, b.clock_ms, b.cells.clone());
        hashes.insert(b.height, b.hash);
        window = MedianWindow::from_slice(&b.timestamps);
    }
    (engine, window, hashes)
}

fn dao_events(b: &BlockInput, net: &omavote_core::network::NetworkParams) -> Vec<DaoEvent> {
    let mut v = Vec::new();
    for tx in &b.transactions {
        for op in &tx.inputs {
            v.push(DaoEvent::Spent { op: *op, height: b.number });
        }
        for o in &tx.outputs {
            if o.type_.as_ref().map(|t| net.is_dao_type(t)).unwrap_or(false) && o.data == [0u8; 8] {
                v.push(DaoEvent::Created {
                    op: OutPoint { tx_hash: tx.hash, index: o.index },
                    owner_id: o.lock.hash(),
                    capacity: o.capacity,
                    height: b.number,
                });
            }
        }
    }
    v
}

pub type Shared = Arc<RwLock<ChainState>>;

pub fn read(s: &Shared) -> std::sync::RwLockReadGuard<'_, ChainState> {
    s.read().unwrap_or_else(|e| e.into_inner())
}

pub fn write(s: &Shared) -> std::sync::RwLockWriteGuard<'_, ChainState> {
    s.write().unwrap_or_else(|e| e.into_inner())
}

pub struct Syncer<S: Source> {
    pub src: S,
    pub store: Option<Arc<Store>>,
    pub state: Shared,
    pub cfg: SyncConfig,
}

impl<S: Source> Syncer<S> {
    pub fn new(src: S, store: Option<Arc<Store>>, cfg: SyncConfig) -> Self {
        let state = Arc::new(RwLock::new(ChainState::new(&cfg)));
        Syncer { src, store, state, cfg }
    }

    /// Rebuild the in-memory state from the block cache (no network access).
    pub fn load_from_store(&self) -> Result<u64> {
        let store = match &self.store {
            Some(s) => s.clone(),
            None => return Ok(0),
        };
        let mut st = write(&self.state);
        *st = ChainState::new(&self.cfg);
        let mut n = 0u64;
        store.for_each_block(0, u64::MAX, |row| {
            st.apply_row(&row, &self.cfg)?;
            n += 1;
            Ok(())
        })?;
        Ok(n)
    }

    /// One round: follow the node up to its tip (or one batch), handling reorgs.
    /// Returns the number of blocks applied.
    pub async fn step(&self) -> Result<usize> {
        let mut node_tip = self.src.tip().await?;
        if let Some(stop) = self.cfg.stop_at {
            node_tip = node_tip.min(stop);
        }
        write(&self.state).node_tip = Some(node_tip);
        let ours = read(&self.state).tip();
        if let Some((n, h, _)) = ours {
            let canonical = if n > node_tip { None } else { self.src.hash(n).await? };
            if canonical != Some(h) {
                self.rollback(node_tip).await?;
                return Ok(0);
            }
        }
        let next = ours.map(|t| t.0 + 1).unwrap_or(0);
        debug_assert!(self.cfg.bootstrap.is_none() || ours.is_some());
        if next > node_tip {
            let mut st = write(&self.state);
            st.synced = true;
            st.last_sync_ms = now_ms();
            st.last_error = None;
            return Ok(0);
        }
        let end = node_tip.min(next + self.cfg.batch as u64 - 1);
        let fetches = (next..=end).map(|n| self.src.block(n));
        let blocks = futures::future::try_join_all(fetches).await?;
        let mut rows = Vec::new();
        let mut events = Vec::new();
        {
            let mut st = write(&self.state);
            for (i, raw) in blocks.into_iter().enumerate() {
                let raw = raw.ok_or_else(|| anyhow!("node has no block {} (tip moved back)", next + i as u64))?;
                if let Some((_, h, _)) = st.tip() {
                    if raw.parent_hash != h {
                        break; // reorg between fetches; detected next round
                    }
                }
                let (row, ev) = st.apply_raw(&raw, &self.cfg)?;
                rows.push(row);
                events.extend(ev);
            }
            st.synced = rows.last().map(|r| r.number >= node_tip).unwrap_or(false);
            st.last_sync_ms = now_ms();
            st.last_error = None;
        }
        if let Some(store) = &self.store {
            store.append(&rows, &events)?;
        }
        if self.cfg.check_clock {
            for r in &rows {
                if r.number == 0 {
                    continue;
                }
                if let Some(m) = self.src.median_time(&r.parent_hash).await? {
                    if m != r.clock_ms {
                        bail!("clock mismatch at block {}: computed {} but node median time of parent is {}", r.number, r.clock_ms, m);
                    }
                }
            }
        }
        Ok(rows.len())
    }

    async fn rollback(&self, node_tip: u64) -> Result<()> {
        let store = match &self.store {
            Some(s) => s.clone(),
            None => bail!("the canonical chain changed during replay; run again"),
        };
        let our_tip = read(&self.state).tip().map(|t| t.0).unwrap_or(0);
        let floor = self.cfg.bootstrap.as_ref().map(|b| b.height).unwrap_or(0);
        let mut n = our_tip.min(node_tip);
        let fork: Option<u64> = loop {
            let ours = match read(&self.state).hashes.get(&n).copied() {
                Some(h) => Some(h),
                None => store.block_hash(n)?,
            };
            let theirs = self.src.hash(n).await?;
            if ours.is_some() && ours == theirs {
                break Some(n);
            }
            if n <= floor {
                break None;
            }
            n -= 1;
        };
        let fork_height = fork.ok_or_else(|| {
            if floor > 0 {
                anyhow!("the chain reorganized below the bootstrap height {floor}; rebuild the database")
            } else {
                anyhow!("no common ancestor with the node (different genesis?)")
            }
        })?;
        store.truncate_above(fork_height)?;
        let mut st = write(&self.state);
        let snap = st.snapshots.iter().rev().find(|s| s.height <= fork_height).cloned();
        let from = match snap {
            Some(s) => {
                st.engine = s.engine;
                st.window = s.window;
                s.height + 1
            }
            None => {
                let (engine, window, hashes) = fresh(&self.cfg);
                st.engine = engine;
                st.window = window;
                st.hashes = hashes;
                floor + if self.cfg.bootstrap.is_some() { 1 } else { 0 }
            }
        };
        st.snapshots.retain(|s| s.height <= fork_height);
        st.hashes.retain(|h, _| *h < from);
        if let Some(b) = &self.cfg.bootstrap {
            for (h, n, _) in &b.anchors {
                st.hashes.insert(*n, *h);
            }
            st.hashes.insert(b.height, b.hash);
        }
        let cfg = &self.cfg;
        store.for_each_block(from, fork_height, |row| st.apply_row(&row, cfg))?;
        st.reorgs.push(ReorgEvent { at_ms: now_ms(), old_tip: our_tip, fork_height, depth: our_tip - fork_height });
        st.synced = false;
        tracing::warn!(old_tip = our_tip, fork_height, "canonical chain changed; rolled back to the common ancestor");
        Ok(())
    }

    /// Follow the node forever.
    pub async fn run(self: Arc<Self>) {
        loop {
            match self.step().await {
                Ok(n) if n > 0 => continue,
                Ok(_) => tokio::time::sleep(self.cfg.poll_interval).await,
                Err(e) => {
                    tracing::warn!("sync: {e:#}");
                    write(&self.state).last_error = Some(format!("{e:#}"));
                    tokio::time::sleep(self.cfg.poll_interval * 5).await;
                }
            }
        }
    }

    /// Sync until the node tip (or `stop_at`) is reached.
    pub async fn catch_up(&self) -> Result<()> {
        loop {
            let n = self.step().await?;
            if n == 0 && read(&self.state).synced {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{RawOutput, RawTx};
    use omavote_core::molecule::Script;
    use omavote_core::network::NetworkParams;
    use omavote_core::testkit::test_network;
    use std::sync::Mutex;

    struct Mock {
        chain: Mutex<Vec<RawBlock>>,
    }

    impl Source for Mock {
        async fn tip(&self) -> Result<u64> {
            Ok(self.chain.lock().unwrap().len() as u64 - 1)
        }
        async fn block(&self, n: u64) -> Result<Option<RawBlock>> {
            Ok(self.chain.lock().unwrap().get(n as usize).cloned())
        }
        async fn hash(&self, n: u64) -> Result<Option<Hash32>> {
            Ok(self.chain.lock().unwrap().get(n as usize).map(|b| b.hash))
        }
        async fn median_time(&self, _hash: &Hash32) -> Result<Option<u64>> {
            Ok(None)
        }
    }

    fn hash(label: &str, n: u64) -> Hash32 {
        omavote_core::hash::ckb_hash(format!("{label}/{n}").as_bytes())
    }

    fn deposit_tx(net: &NetworkParams, label: &str, owner: &Script, ckb: u64) -> RawTx {
        RawTx {
            hash: hash(label, 0),
            inputs: vec![],
            outputs: vec![RawOutput { capacity: ckb * 100_000_000, lock: owner.clone(), type_: Some(net.dao_script()), data: vec![0; 8] }],
            witnesses: vec![],
        }
    }

    fn spend_tx(label: &str, op: OutPoint) -> RawTx {
        RawTx { hash: hash(label, 0), inputs: vec![op], outputs: vec![], witnesses: vec![] }
    }

    /// Build `len` blocks on top of `prefix`, with `txs` placed at given heights.
    fn extend(prefix: &[RawBlock], label: &str, len: u64, mut txs: BTreeMap<u64, Vec<RawTx>>) -> Vec<RawBlock> {
        let mut v = prefix.to_vec();
        while (v.len() as u64) < len {
            let n = v.len() as u64;
            let parent = v.last().map(|b| b.hash).unwrap_or([0; 32]);
            v.push(RawBlock {
                number: n,
                hash: if n == 0 { test_network().genesis_hash } else { hash(label, n) },
                parent_hash: parent,
                timestamp: 1_000_000 + n * 1000,
                txs: txs.remove(&n).unwrap_or_default(),
            });
        }
        v
    }

    fn syncer(chain: Vec<RawBlock>) -> Syncer<Mock> {
        let mut cfg = SyncConfig::new(EngineConfig::new(test_network()));
        cfg.snapshot_every = 4;
        cfg.batch = 3;
        Syncer::new(Mock { chain: Mutex::new(chain) }, Some(Arc::new(Store::in_memory().unwrap())), cfg)
    }

    #[tokio::test]
    async fn reorg_rolls_back_deposits_and_spends() {
        let net = test_network();
        let x = net.secp256k1.with_args(vec![1; 20]);
        let y = net.secp256k1.with_args(vec![2; 20]);
        let dx = deposit_tx(&net, "dx", &x, 1000);
        let x_op = OutPoint { tx_hash: dx.hash, index: 0 };
        // Chain A: X deposits at 2, spends at 5.
        let a = extend(&[], "a", 12, BTreeMap::from([(2, vec![dx.clone()]), (5, vec![spend_tx("sx", x_op)])]));
        let s = syncer(a.clone());
        s.catch_up().await.unwrap();
        {
            let st = read(&s.state);
            assert_eq!(st.engine.tip.unwrap().0, 11);
            assert_eq!(st.engine.owner_balance(&x.hash()), 0);
        }
        // Chain B forks after block 3: X never spends, Y deposits at 6.
        let b = extend(&a[..4], "b", 15, BTreeMap::from([(6, vec![deposit_tx(&net, "dy", &y, 500)])]));
        *s.src.chain.lock().unwrap() = b.clone();
        s.catch_up().await.unwrap();
        {
            let st = read(&s.state);
            assert_eq!(st.engine.tip.unwrap().0, 14);
            assert_eq!(st.engine.tip.unwrap().1, b[14].hash);
            assert_eq!(st.engine.owner_balance(&x.hash()), 1000 * 100_000_000);
            assert_eq!(st.engine.owner_balance(&y.hash()), 500 * 100_000_000);
            assert_eq!(st.reorgs.len(), 1);
            assert_eq!(st.reorgs[0].fork_height, 3);
            // Anchors on the abandoned branch are no longer known: signed objects that
            // reference them become ANCHOR_INVALID when replayed on the new chain.
            assert!(st.engine.block_clock(&a[5].hash).is_none());
            assert!(st.engine.block_clock(&b[5].hash).is_some());
            assert!(st.engine.block_clock(&a[3].hash).is_some());
            let store = s.store.as_ref().unwrap();
            assert_eq!(store.deposits_at(&x.hash(), 14).unwrap().len(), 1);
            assert_eq!(store.deposits_at(&y.hash(), 5).unwrap().len(), 0);
            assert_eq!(store.deposits_at(&y.hash(), 6).unwrap().len(), 1);
        }

        // A fresh sync of chain B gives the same state, and so does a restart from the
        // rolled-back cache.
        let fresh = syncer(b.clone());
        fresh.catch_up().await.unwrap();
        {
            let st = read(&fresh.state);
            assert_eq!(st.engine.owner_balance(&x.hash()), 1000 * 100_000_000);
            assert_eq!(st.engine.owner_balance(&y.hash()), 500 * 100_000_000);
        }
        assert_eq!(s.load_from_store().unwrap(), 15);
        let st = read(&s.state);
        assert_eq!(st.engine.tip.unwrap().1, b[14].hash);
        assert_eq!(st.engine.owner_balance(&x.hash()), 1000 * 100_000_000);
        assert_eq!(st.engine.owner_balance(&y.hash()), 500 * 100_000_000);
    }

    #[tokio::test]
    async fn restart_from_cache_matches_live_state() {
        let net = test_network();
        let x = net.secp256k1.with_args(vec![1; 20]);
        let a = extend(&[], "a", 30, BTreeMap::from([(7, vec![deposit_tx(&net, "dx", &x, 42)])]));
        let s = syncer(a.clone());
        s.catch_up().await.unwrap();
        let live_tip = read(&s.state).engine.tip;
        let n = s.load_from_store().unwrap();
        assert_eq!(n, 30);
        let st = read(&s.state);
        assert_eq!(st.engine.tip, live_tip);
        assert_eq!(st.engine.owner_balance(&x.hash()), 42 * 100_000_000);
    }
}
