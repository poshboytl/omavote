//! SQLite storage: reduced canonical blocks (cache for restart and reorg replay),
//! DAO deposit history (historical power queries) and the relay queue.
//!
//! Every chain-derived table can be dropped and rebuilt from the node; the relay
//! queue and receipts cannot and must be backed up (docs/13 §5, §11).

use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use omavote_core::molecule::OutPoint;
use omavote_core::util::{parse_hash, to_hex, Hash32};
use rusqlite::{params, Connection, OptionalExtension};

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug)]
pub struct BlockRow {
    pub number: u64,
    pub hash: Hash32,
    pub parent_hash: Hash32,
    pub timestamp: u64,
    pub clock_ms: u64,
    /// Reduced block JSON (`BlockInput::to_json`) when it has relevant transactions.
    pub body: Option<String>,
}

#[derive(Clone, Debug)]
pub enum DaoEvent {
    Created { op: OutPoint, owner_id: Hash32, capacity: u64, height: u64 },
    Spent { op: OutPoint, height: u64 },
}

#[derive(Clone, Debug)]
pub struct RelayItem {
    pub id: i64,
    pub message_kind: String,
    pub object_id: String,
    pub carrier_kind: u8,
    pub scope_id: String,
    pub envelope: String,
    pub envelope_hash: String,
    pub received_ms: u64,
    pub publish_by_ms: Option<u64>,
    pub status: String,
    pub tx_hash: Option<String>,
    pub block_number: Option<u64>,
    pub block_hash: Option<String>,
    pub error: Option<String>,
    pub receipt: String,
}

#[derive(Clone, Debug)]
pub struct RelayTx {
    pub tx_hash: String,
    pub raw: String,
    pub status: String,
    pub created_ms: u64,
    pub block_number: Option<u64>,
    pub block_hash: Option<String>,
    pub item_ids: Vec<i64>,
    pub inputs: Vec<String>,
}

fn h(s: &str) -> Result<Hash32> {
    parse_hash(s, "stored hash").map_err(|e| anyhow!("{e}"))
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (
    number INTEGER PRIMARY KEY,
    hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    clock_ms INTEGER NOT NULL,
    body TEXT
);
CREATE TABLE IF NOT EXISTS dao_history (
    tx_hash TEXT NOT NULL,
    idx INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    created_height INTEGER NOT NULL,
    spent_height INTEGER,
    PRIMARY KEY (tx_hash, idx)
);
CREATE INDEX IF NOT EXISTS dao_history_owner ON dao_history(owner_id);
CREATE TABLE IF NOT EXISTS relay_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    carrier_kind INTEGER NOT NULL,
    scope_id TEXT NOT NULL,
    envelope TEXT NOT NULL,
    envelope_hash TEXT NOT NULL,
    received_ms INTEGER NOT NULL,
    publish_by_ms INTEGER,
    status TEXT NOT NULL,
    tx_hash TEXT,
    block_number INTEGER,
    block_hash TEXT,
    error TEXT,
    receipt TEXT NOT NULL,
    UNIQUE (message_kind, object_id)
);
CREATE INDEX IF NOT EXISTS relay_items_status ON relay_items(status);
CREATE TABLE IF NOT EXISTS relay_txs (
    tx_hash TEXT PRIMARY KEY,
    raw TEXT NOT NULL,
    status TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    block_number INTEGER,
    block_hash TEXT,
    item_ids TEXT NOT NULL,
    inputs TEXT NOT NULL
);
";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open database {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn c(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -- meta --------------------------------------------------------------

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.c().query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.c().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Drop every chain-derived table (used when the network or protocol settings change).
    pub fn reset_chain(&self) -> Result<()> {
        self.c().execute_batch("DELETE FROM blocks; DELETE FROM dao_history;")?;
        Ok(())
    }

    // -- blocks ------------------------------------------------------------

    pub fn append(&self, rows: &[BlockRow], dao: &[DaoEvent]) -> Result<()> {
        let mut c = self.c();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare_cached(
                "INSERT OR REPLACE INTO blocks (number, hash, parent_hash, timestamp, clock_ms, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for r in rows {
                ins.execute(params![
                    r.number as i64,
                    to_hex(&r.hash),
                    to_hex(&r.parent_hash),
                    r.timestamp as i64,
                    r.clock_ms as i64,
                    r.body
                ])?;
            }
            let mut created = tx.prepare_cached(
                "INSERT OR REPLACE INTO dao_history (tx_hash, idx, owner_id, capacity, created_height, spent_height) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
            )?;
            let mut spent = tx.prepare_cached("UPDATE dao_history SET spent_height = ?3 WHERE tx_hash = ?1 AND idx = ?2")?;
            for e in dao {
                match e {
                    DaoEvent::Created { op, owner_id, capacity, height } => {
                        created.execute(params![
                            to_hex(&op.tx_hash),
                            op.index as i64,
                            to_hex(owner_id),
                            *capacity as i64,
                            *height as i64
                        ])?;
                    }
                    DaoEvent::Spent { op, height } => {
                        spent.execute(params![to_hex(&op.tx_hash), op.index as i64, *height as i64])?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn block_hash(&self, number: u64) -> Result<Option<Hash32>> {
        let s: Option<String> =
            self.c().query_row("SELECT hash FROM blocks WHERE number = ?1", [number as i64], |r| r.get(0)).optional()?;
        s.map(|s| h(&s)).transpose()
    }

    /// Stream stored blocks in height order within `[from, to]`.
    pub fn for_each_block(&self, from: u64, to: u64, mut f: impl FnMut(BlockRow) -> Result<()>) -> Result<()> {
        let c = self.c();
        let mut st = c.prepare(
            "SELECT number, hash, parent_hash, timestamp, clock_ms, body FROM blocks WHERE number >= ?1 AND number <= ?2 ORDER BY number",
        )?;
        let mut rows = st.query(params![from as i64, to.min(i64::MAX as u64) as i64])?;
        while let Some(r) = rows.next()? {
            f(row_to_block(r)??)?;
        }
        Ok(())
    }

    /// Remove blocks above `height` and undo their DAO history.
    pub fn truncate_above(&self, height: u64) -> Result<()> {
        let mut c = self.c();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM blocks WHERE number > ?1", [height as i64])?;
        tx.execute("DELETE FROM dao_history WHERE created_height > ?1", [height as i64])?;
        tx.execute("UPDATE dao_history SET spent_height = NULL WHERE spent_height > ?1", [height as i64])?;
        tx.commit()?;
        Ok(())
    }

    /// DAO deposits of an owner live at the end of block `height`.
    pub fn deposits_at(&self, owner_id: &Hash32, height: u64) -> Result<Vec<(OutPoint, u64, u64)>> {
        let c = self.c();
        let mut st = c.prepare(
            "SELECT tx_hash, idx, capacity, created_height FROM dao_history
             WHERE owner_id = ?1 AND created_height <= ?2 AND (spent_height IS NULL OR spent_height > ?2)
             ORDER BY tx_hash, idx",
        )?;
        let rows = st
            .query_map(params![to_hex(owner_id), height as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(t, i, cap, ch)| Ok((OutPoint { tx_hash: h(&t)?, index: i as u32 }, cap as u64, ch as u64)))
            .collect()
    }

    // -- relay ---------------------------------------------------------------

    pub fn relay_find(&self, message_kind: &str, object_id: &str) -> Result<Option<RelayItem>> {
        self.c()
            .query_row(
                &format!("SELECT {RELAY_COLS} FROM relay_items WHERE message_kind = ?1 AND object_id = ?2"),
                params![message_kind, object_id],
                row_to_item,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn relay_by_object(&self, object_id: &str) -> Result<Vec<RelayItem>> {
        let c = self.c();
        let mut st = c.prepare(&format!("SELECT {RELAY_COLS} FROM relay_items WHERE object_id = ?1 ORDER BY id"))?;
        let v = st.query_map([object_id], row_to_item)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn relay_insert(
        &self,
        message_kind: &str,
        object_id: &str,
        carrier_kind: u8,
        scope_id: &str,
        envelope: &str,
        envelope_hash: &str,
        received_ms: u64,
        publish_by_ms: Option<u64>,
        receipt: &str,
    ) -> Result<i64> {
        let c = self.c();
        c.execute(
            "INSERT INTO relay_items (message_kind, object_id, carrier_kind, scope_id, envelope, envelope_hash, received_ms, publish_by_ms, status, receipt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'RECEIVED', ?9)",
            params![
                message_kind,
                object_id,
                carrier_kind as i64,
                scope_id,
                envelope,
                envelope_hash,
                received_ms as i64,
                publish_by_ms.map(|x| x as i64),
                receipt
            ],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn relay_with_status(&self, statuses: &[&str]) -> Result<Vec<RelayItem>> {
        let c = self.c();
        let list = statuses.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
        let mut st = c.prepare(&format!("SELECT {RELAY_COLS} FROM relay_items WHERE status IN ({list}) ORDER BY id"))?;
        let v = st.query_map([], row_to_item)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    }

    pub fn relay_counts(&self) -> Result<Vec<(String, u64)>> {
        let c = self.c();
        let mut st = c.prepare("SELECT status, COUNT(*) FROM relay_items GROUP BY status ORDER BY status")?;
        let v = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    }

    pub fn relay_set_status(
        &self,
        ids: &[i64],
        status: &str,
        tx_hash: Option<&str>,
        block: Option<(u64, &str)>,
        error: Option<&str>,
    ) -> Result<()> {
        let mut c = self.c();
        let tx = c.transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE relay_items SET status = ?2, tx_hash = ?3, block_number = ?4, block_hash = ?5, error = ?6 WHERE id = ?1",
                params![id, status, tx_hash, block.map(|b| b.0 as i64), block.map(|b| b.1), error],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn relay_tx_insert(&self, t: &RelayTx) -> Result<()> {
        self.c().execute(
            "INSERT INTO relay_txs (tx_hash, raw, status, created_ms, block_number, block_hash, item_ids, inputs) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
            params![
                t.tx_hash,
                t.raw,
                t.status,
                t.created_ms as i64,
                serde_json::to_string(&t.item_ids)?,
                serde_json::to_string(&t.inputs)?
            ],
        )?;
        Ok(())
    }

    pub fn relay_tx_update(&self, tx_hash: &str, status: &str, block: Option<(u64, &str)>) -> Result<()> {
        self.c().execute(
            "UPDATE relay_txs SET status = ?2, block_number = ?3, block_hash = ?4 WHERE tx_hash = ?1",
            params![tx_hash, status, block.map(|b| b.0 as i64), block.map(|b| b.1)],
        )?;
        Ok(())
    }

    pub fn relay_txs_with_status(&self, statuses: &[&str]) -> Result<Vec<RelayTx>> {
        let c = self.c();
        let list = statuses.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
        let mut st = c.prepare(&format!(
            "SELECT tx_hash, raw, status, created_ms, block_number, block_hash, item_ids, inputs FROM relay_txs WHERE status IN ({list}) ORDER BY created_ms"
        ))?;
        let v = st
            .query_map([], |r| {
                Ok(RelayTx {
                    tx_hash: r.get(0)?,
                    raw: r.get(1)?,
                    status: r.get(2)?,
                    created_ms: r.get::<_, i64>(3)? as u64,
                    block_number: r.get::<_, Option<i64>>(4)?.map(|x| x as u64),
                    block_hash: r.get(5)?,
                    item_ids: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                    inputs: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    }
}

const RELAY_COLS: &str = "id, message_kind, object_id, carrier_kind, scope_id, envelope, envelope_hash, received_ms, publish_by_ms, status, tx_hash, block_number, block_hash, error, receipt";

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<RelayItem> {
    Ok(RelayItem {
        id: r.get(0)?,
        message_kind: r.get(1)?,
        object_id: r.get(2)?,
        carrier_kind: r.get::<_, i64>(3)? as u8,
        scope_id: r.get(4)?,
        envelope: r.get(5)?,
        envelope_hash: r.get(6)?,
        received_ms: r.get::<_, i64>(7)? as u64,
        publish_by_ms: r.get::<_, Option<i64>>(8)?.map(|x| x as u64),
        status: r.get(9)?,
        tx_hash: r.get(10)?,
        block_number: r.get::<_, Option<i64>>(11)?.map(|x| x as u64),
        block_hash: r.get(12)?,
        error: r.get(13)?,
        receipt: r.get(14)?,
    })
}

fn row_to_block(r: &rusqlite::Row) -> rusqlite::Result<Result<BlockRow>> {
    let number: i64 = r.get(0)?;
    let hash: String = r.get(1)?;
    let parent: String = r.get(2)?;
    let timestamp: i64 = r.get(3)?;
    let clock: i64 = r.get(4)?;
    let body: Option<String> = r.get(5)?;
    Ok((|| {
        Ok(BlockRow {
            number: number as u64,
            hash: h(&hash)?,
            parent_hash: h(&parent)?,
            timestamp: timestamp as u64,
            clock_ms: clock as u64,
            body,
        })
    })())
}
