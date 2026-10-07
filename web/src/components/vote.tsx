import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { useWallet } from "../app/wallet";
import type { Core } from "../lib/core";
import type { Eip1193Provider } from "../lib/eip1193";
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  adapterAccepted,
  anchorAbove,
  ballotAnchorFloor,
  ballotEnvelope,
  ballotSequence,
  bestCandidate,
  checkReceipt,
  delegateBlocked,
  delegateOptions,
  evmOwnerCandidates,
  lockLabel,
  newBallot,
  ownerFromAddress,
  signVerifySubmit,
  submitEnvelope,
  verifyKeySig,
  verifyOwnerSig,
  walletSigner,
  type DelegateOption,
  type PreparedBallot,
  type SignSubmitResult,
  type StepName,
  type VoterIdentity,
} from "../lib/flow";
import { big, formatCkb, utcHuman } from "../lib/format";
import { lastAnchor, rememberAnchor, savePending } from "../lib/storage";
import type { Action, AnchorInfo, BallotEnvelope, KeyDescriptor, Manifest, NetworkInfo, ProposalDetail } from "../lib/types";
import { CodeBadge } from "./badges";
import { NeuronSignBox, ReceiptNote, SignTextView, SyncIssues, useSyncCheck, WalletBar } from "./sign";
import { SubmissionTracker } from "./tracker";
import { Badge, Check, DownloadJsonButton, ErrorView, Loading, Mono, Notice, useErrorText } from "./ui";

export interface VoterEntry {
  key: string;
  voter: VoterIdentity;
  /** Voting key descriptor for delegate ballots (local verification). */
  descriptor?: KeyDescriptor;
  ownerId: string;
  ownerAddress: string;
  weight: string | null;
}

type SignerSpec = { kind: "wallet"; provider: Eip1193Provider; address: string } | { kind: "neuron"; address: string };

interface Job {
  entry: VoterEntry;
  prepared: PreparedBallot;
  anchor: AnchorInfo;
  step: StepName | null;
  result: SignSubmitResult<BallotEnvelope> | null;
  error: unknown;
}

const ACTIONS: Action[] = ["YES", "NO", "CANCEL"];

export function ChoicePicker({ value, onChange }: { value: Action; onChange: (a: Action) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="choices">
      <legend>{t("vote.choice")}</legend>
      {ACTIONS.map((a) => (
        <label key={a} className={`choice choice-${a.toLowerCase()}${value === a ? " selected" : ""}`}>
          <input type="radio" name="choice" value={a} checked={value === a} onChange={() => onChange(a)} />
          <span className="choice-title">{t(`choice.${a}`)}</span>
          <span className="choice-help">{t(`choiceHelp.${a}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}

function sequenceOf(pollId: string, e: VoterEntry): string {
  return ballotSequence(pollId, e.ownerId);
}

/**
 * Prepares one ballot per voter entry (fresh anchor and nonce), shows the exact
 * texts, collects signatures (wallet or Neuron paste), verifies them locally,
 * submits the envelopes and follows them until the indexer shows the selection.
 */
export function BallotRunner({
  core,
  network,
  manifest,
  detail,
  entries,
  action,
  signer,
}: {
  core: Core;
  network: NetworkInfo;
  manifest: Manifest;
  detail: ProposalDetail;
  entries: VoterEntry[];
  action: Action;
  signer: SignerSpec;
}) {
  const { t } = useI18n();
  const { api } = useApp();
  const errorText = useErrorText();
  const sync = useSyncCheck();
  const [ack, setAck] = useState(false);
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "running">("idle");
  const [waitingBlock, setWaitingBlock] = useState<{ current: string; floor: string } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<unknown>(null);
  const pollId = detail.poll_id;
  const receiptKey = network.receipt_key;

  const update = (i: number, patch: Partial<Job>) => setJobs((prev) => prev.map((j, k) => (k === i ? { ...j, ...patch } : j)));

  const verifierFor = (e: VoterEntry) => (text: string, sig: string) =>
    e.voter.authority === "owner"
      ? verifyOwnerSig(core, network.network, e.voter.adapter, e.voter.ownerLock, text, sig)
      : e.descriptor
        ? verifyKeySig(core, e.descriptor, text, sig)
        : { ok: false, error: "missing key descriptor" };

  const keep = (job: Job, envelope: BallotEnvelope) => {
    rememberAnchor(sequenceOf(pollId, job.entry), job.anchor);
    savePending({
      id: job.prepared.ballotId,
      kind: "ballot",
      label: `${job.prepared.summary} · ${job.entry.ownerAddress}`,
      poll_id: pollId,
      owner_id: job.entry.ownerId,
      envelope,
      created_ms: Date.now(),
    });
  };

  const prepare = async () => {
    setError(null);
    setPhase("preparing");
    try {
      const a = await sync.check();
      if ((!a || !a.ok) && !ack) {
        setPhase("idle");
        return;
      }
      // Strictly above every earlier ballot of each owner in this poll (indexed or
      // signed on this device): two different ballots on one anchor are a CONFLICT.
      let floor: bigint | null = null;
      for (const e of entries) {
        const f = await ballotAnchorFloor(api, pollId, e.ownerId, detail.registered.position.height, lastAnchor(sequenceOf(pollId, e)));
        if (f !== null && (floor === null || f > floor)) floor = f;
      }
      const anchor = await anchorAbove(api, floor, {
        timeoutMs: 180_000,
        onWait: (cur, fl) => setWaitingBlock({ current: cur.number, floor: fl.toString() }),
      });
      setWaitingBlock(null);
      setJobs(
        entries.map((entry) => ({
          entry,
          prepared: newBallot(core, network.network, manifest, entry.voter, action, anchor),
          anchor,
          step: null,
          result: null,
          error: null,
        })),
      );
      setPhase("ready");
    } catch (e) {
      setWaitingBlock(null);
      setError(e);
      setPhase("idle");
    }
  };

  const signAllWithWallet = async () => {
    if (signer.kind !== "wallet") return;
    setPhase("running");
    const snapshot = jobs;
    for (let i = 0; i < snapshot.length; i++) {
      const job = snapshot[i];
      // Already signed and verified: only a resubmission is needed (same envelope).
      if (!job || job.result?.envelope) continue;
      update(i, { step: "signing", error: null });
      try {
        const res = await signVerifySubmit({
          core,
          api,
          request: job.prepared,
          sign: walletSigner(signer.provider, signer.address),
          verify: verifierFor(job.entry),
          envelope: (sig) => ballotEnvelope(job.prepared.body, sig),
          objectId: job.prepared.ballotId,
          itemKind: "ballot",
          receiptKey,
          genesis: manifest.network_genesis_hash,
          onStep: (s) => update(i, { step: s }),
          onSigned: (env) => keep(job, env),
        });
        update(i, { result: res, step: null });
        if (!res.verify.ok) break;
      } catch (e) {
        update(i, { error: e, step: null });
        break;
      }
    }
    setPhase("ready");
  };

  const submitSigned = async (i: number, signature: string) => {
    const job = jobs[i];
    if (!job) return;
    const envelope = ballotEnvelope(job.prepared.body, signature);
    keep(job, envelope);
    update(i, { step: "submitting", error: null });
    try {
      const submit = await submitEnvelope(core, api, envelope);
      const receipt = submit.ok
        ? checkReceipt(core, submit.item, {
            receiptKey,
            objectId: job.prepared.ballotId,
            itemKind: "ballot",
            envelopeJcs: submit.envelopeJcs,
            genesis: manifest.network_genesis_hash,
          })
        : null;
      update(i, { step: null, result: { signature, verify: { ok: true, error: null }, envelope, submit, receipt } });
    } catch (e) {
      update(i, { step: null, error: e });
    }
  };

  const disabled = entries.length === 0 || phase === "preparing" || phase === "running";
  return (
    <div className="runner">
      <SyncIssues assessment={sync.assessment} />
      {sync.assessment && !sync.assessment.ok && (
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t("sync.ack")}
        </label>
      )}
      {phase !== "ready" && phase !== "running" && (
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void prepare()}>
          {phase === "preparing" ? t("vote.preparing") : t("vote.prepare", { n: entries.length, choice: t(`choice.${action}`) })}
        </button>
      )}
      {phase === "preparing" && waitingBlock && (
        <Notice tone="info">{t("anchor.waiting", { current: waitingBlock.current, floor: waitingBlock.floor })}</Notice>
      )}
      {error !== null && <ErrorView error={error} />}
      {jobs.length > 0 && (phase === "ready" || phase === "running") && (
        <div className="jobs">
          <Notice tone="info">{t("vote.reviewText")}</Notice>
          {jobs.map((job, i) => (
            <div className="job" key={job.prepared.ballotId}>
              <div className="job-head">
                <strong>{t("vote.forOwner")}</strong> <Mono value={job.entry.ownerAddress} copy={false} />
                {job.entry.weight !== null && <Badge tone="neutral">{t("vote.currentDeposit", { amount: formatCkb(job.entry.weight) })}</Badge>}
                <Badge tone="info">{job.entry.voter.authority === "owner" ? t("vote.direct") : t("vote.delegated")}</Badge>
              </div>
              <SignTextView req={job.prepared} />
              <JobResult job={job} />
              {signer.kind === "neuron" && !job.result?.submit?.ok && (
                <NeuronSignBox
                  req={job.prepared}
                  address={signer.address}
                  verify={(sig) => verifierFor(job.entry)(job.prepared.text, sig)}
                  onVerified={(sig) => void submitSigned(i, sig)}
                  disabled={job.step !== null}
                  submits
                />
              )}
              {job.result?.envelope && job.result.submit && !job.result.submit.ok && (
                <button type="button" className="btn" onClick={() => void submitSigned(i, job.result?.signature ?? "")}>
                  {t("vote.resubmit")}
                </button>
              )}
              {job.result?.envelope && (
                <DownloadJsonButton
                  filename={`omavote-ballot-${job.prepared.ballotId.slice(2, 18)}.json`}
                  value={job.result.envelope}
                  label={t("vote.downloadEnvelope")}
                />
              )}
              {job.error !== null && job.error !== undefined && <Notice tone="bad">{errorText(job.error)}</Notice>}
            </div>
          ))}
          {signer.kind === "wallet" && jobs.some((j) => !j.result?.envelope) && (
            <button type="button" className="btn btn-primary" disabled={phase === "running"} onClick={() => void signAllWithWallet()}>
              {phase === "running" ? t("vote.signing") : t("vote.signWallet", { n: jobs.filter((j) => !j.result?.envelope).length })}
            </button>
          )}
          <button
            type="button"
            className="btn btn-quiet"
            disabled={phase === "running"}
            onClick={() => {
              setJobs([]);
              setPhase("idle");
            }}
          >
            {t("vote.startOver")}
          </button>
          <ReceiptNote />
        </div>
      )}
    </div>
  );
}

function JobResult({ job }: { job: Job }) {
  const { t, tk } = useI18n();
  const r = job.result;
  return (
    <div className="job-result">
      {job.step && <div className="muted">{tk(`stepName.${job.step}`)}</div>}
      {r && <Check ok={r.verify.ok}>{r.verify.ok ? t("sig.verifiedLocally") : t("sig.verifyFailed", { detail: r.verify.error ?? "" })}</Check>}
      {r?.submit && !r.submit.ok && (
        <Notice tone="bad" title={t("vote.rejectedByRelay")}>
          <CodeBadge code={r.submit.code} /> {r.submit.detail}
        </Notice>
      )}
      {r?.submit?.ok && (
        <>
          {r.submit.duplicate && <Notice tone="info">{t("vote.duplicate")}</Notice>}
          <SubmissionTracker
            target={{ kind: "ballot", objectId: job.prepared.ballotId, pollId: job.prepared.body.poll_id, ownerId: job.prepared.ownerId }}
            initial={r.submit.item}
            receipt={r.receipt}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OwnerWalletVote({ core, network, detail, action }: { core: Core; network: NetworkInfo; detail: ProposalDetail; action: Action }) {
  const { t } = useI18n();
  const { api } = useApp();
  const w = useWallet();
  const manifest = detail.manifest_payload.manifest;
  const cands = useLoad(
    () => (w.address ? evmOwnerCandidates(core, api, network.network, w.address) : Promise.resolve(null)),
    [w.address, api],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    setChosen(cands.data ? bestCandidate(cands.data)?.lock.owner_id ?? cands.data[0]?.lock.owner_id ?? null : null);
  }, [cands.data]);
  const accepted = adapterAccepted(manifest, "owner", ADAPTER_EVM);
  const c = cands.data?.find((x) => x.lock.owner_id === chosen) ?? null;
  const entries: VoterEntry[] = c
    ? [
        {
          key: c.lock.owner_id,
          voter: { authority: "owner", ownerLock: c.lock.script, adapter: ADAPTER_EVM },
          ownerId: c.lock.owner_id,
          ownerAddress: c.lock.address,
          weight: c.power?.total_shannon ?? null,
        },
      ]
    : [];
  return (
    <div>
      <p className="muted">{t("vote.metamaskIntro")}</p>
      <WalletBar />
      {!accepted && <Notice tone="bad">{t("vote.adapterNotAccepted", { adapter: ADAPTER_EVM })}</Notice>}
      {w.address && cands.loading && <Loading />}
      {cands.error !== null && <ErrorView error={cands.error} />}
      {cands.data && cands.data.length === 0 && <Notice tone="warn">{t("vote.noEvmLocks")}</Notice>}
      {cands.data && cands.data.length > 0 && (
        <fieldset className="owner-pick">
          <legend>{t("vote.ownerLock")}</legend>
          {cands.data.map((x) => (
            <label key={x.lock.owner_id} className="owner-option">
              <input type="radio" name="owner" checked={chosen === x.lock.owner_id} onChange={() => setChosen(x.lock.owner_id)} />
              <span>
                <Badge tone="neutral">{lockLabel(network.network, x.lock.script)}</Badge> <Mono value={x.lock.address} copy={false} />
                <span className="muted small">
                  {x.power
                    ? t("vote.deposit", { amount: formatCkb(x.power.total_shannon), n: x.power.deposits.length })
                    : t("vote.depositUnknown", { detail: x.error ?? "" })}
                </span>
              </span>
            </label>
          ))}
          {cands.data.every((x) => !x.power || big(x.power.total_shannon) === 0n) && (
            <Notice tone="warn">{action === "CANCEL" ? t("vote.noDepositCancel") : t("vote.noDeposit")}</Notice>
          )}
        </fieldset>
      )}
      {w.address && w.provider && c && accepted && (
        <BallotRunner
          key={`${w.address}:${c.lock.owner_id}:${action}`}
          core={core}
          network={network}
          manifest={manifest}
          detail={detail}
          entries={entries}
          action={action}
          signer={{ kind: "wallet", provider: w.provider, address: w.address }}
        />
      )}
    </div>
  );
}

function DelegateVote({ core, network, detail, action }: { core: Core; network: NetworkInfo; detail: ProposalDetail; action: Action }) {
  const { t, tk } = useI18n();
  const { api } = useApp();
  const w = useWallet();
  const manifest = detail.manifest_payload.manifest;
  const key = useMemo(() => (w.address ? core.evmKey(w.address, network.network) : null), [core, network, w.address]);
  const clock = detail.at?.clock_ms ?? "0";
  const opts = useLoad(
    () => (key ? delegateOptions(core, api, network.network, manifest, key.key_id, clock) : Promise.resolve(null)),
    [key?.key_id, api],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set((opts.data ?? []).filter((o) => !delegateBlocked(o, action)).map((o) => o.grant.authorization_id)));
  }, [opts.data, action]);
  const delegateClosed = big(clock) >= big(detail.delegate_end_ms);
  const usable = (opts.data ?? []).filter((o): o is DelegateOption & { ownerLock: NonNullable<DelegateOption["ownerLock"]> } => !!o.ownerLock);
  const entries: VoterEntry[] =
    key === null
      ? []
      : usable
          .filter((o) => selected.has(o.grant.authorization_id) && !delegateBlocked(o, action))
          .map((o) => ({
            key: o.grant.authorization_id,
            voter: {
              authority: "delegate",
              ownerLock: o.ownerLock,
              authorizationId: o.grant.authorization_id,
              signerKeyId: key.key_id,
              adapter: key.adapter,
            },
            descriptor: key.descriptor,
            ownerId: o.grant.owner_id,
            ownerAddress: o.ownerAddress ?? o.grant.owner_id,
            weight: o.power?.total_shannon ?? null,
          }));
  return (
    <div>
      <p className="muted">{t("vote.delegateIntro")}</p>
      <WalletBar />
      {key && (
        <div className="small">
          {t("vote.yourKey")} <Mono value={key.key_display ?? key.descriptor.kind} /> · key_id <code>{key.key_id.slice(0, 18)}…</code>
        </div>
      )}
      {!adapterAccepted(manifest, "delegate", ADAPTER_EVM) && <Notice tone="bad">{t("vote.adapterNotAccepted", { adapter: ADAPTER_EVM })}</Notice>}
      {delegateClosed && <Notice tone="bad">{t("vote.delegateClosed", { end: utcHuman(detail.delegate_end_ms) })}</Notice>}
      {key && opts.loading && <Loading />}
      {opts.error !== null && <ErrorView error={opts.error} />}
      {opts.data && opts.data.length === 0 && <Notice tone="warn">{t("vote.noGrants")}</Notice>}
      {opts.data && opts.data.length > 0 && (
        <fieldset className="owner-pick">
          <legend>{t("vote.representedOwners")}</legend>
          {opts.data.map((o) => {
            const blocked = delegateBlocked(o, action);
            return (
              <label key={o.grant.authorization_id} className={`owner-option${blocked ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  disabled={blocked}
                  checked={selected.has(o.grant.authorization_id) && !blocked}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(o.grant.authorization_id);
                    else next.delete(o.grant.authorization_id);
                    setSelected(next);
                  }}
                />
                <span>
                  <Mono value={o.ownerAddress ?? o.grant.owner_id} copy={false} />
                  <span className="muted small">
                    {o.power ? t("vote.deposit", { amount: formatCkb(o.power.total_shannon), n: o.power.deposits.length }) : ""}
                    {" · "}
                    {t("vote.grantUntil", { date: utcHuman(o.grant.expires_at_ms) })}
                  </span>
                  {o.problems.length > 0 && (
                    <span className="problems">
                      {o.problems.map((p) => (
                        <Badge key={p} tone={p === "no_deposit" && action === "CANCEL" ? "neutral" : "bad"}>
                          {tk(`delegateProblem.${p}`)}
                        </Badge>
                      ))}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {w.address && w.provider && key && entries.length > 0 && !delegateClosed && (
        <BallotRunner
          key={`${w.address}:${[...selected].sort().join(",")}:${action}`}
          core={core}
          network={network}
          manifest={manifest}
          detail={detail}
          entries={entries}
          action={action}
          signer={{ kind: "wallet", provider: w.provider, address: w.address }}
        />
      )}
    </div>
  );
}

function NeuronVote({ core, network, detail, action }: { core: Core; network: NetworkInfo; detail: ProposalDetail; action: Action }) {
  const { t } = useI18n();
  const { api } = useApp();
  const manifest = detail.manifest_payload.manifest;
  const [input, setInput] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const owner = useMemo(() => {
    if (!address) return null;
    try {
      return { value: ownerFromAddress(core, network.network, address), error: null };
    } catch (e) {
      return { value: null, error: e };
    }
  }, [address, core, network]);
  const power = useLoad(
    () => (owner?.value ? api.ownerPower(owner.value.lock.owner_id) : Promise.resolve(null)),
    [owner?.value?.lock.owner_id, api],
  );
  const accepted = adapterAccepted(manifest, "owner", ADAPTER_CKB);
  const o = owner?.value ?? null;
  const supported = o !== null && o.adapter === ADAPTER_CKB;
  const entries: VoterEntry[] =
    o && supported
      ? [
          {
            key: o.lock.owner_id,
            voter: { authority: "owner", ownerLock: o.lock.script, adapter: ADAPTER_CKB },
            ownerId: o.lock.owner_id,
            ownerAddress: o.lock.address,
            weight: power.data?.total_shannon ?? null,
          },
        ]
      : [];
  return (
    <div>
      <p className="muted">{t("vote.neuronIntro")}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setAddress(input.trim() || null);
        }}
      >
        <label className="field grow">
          <span className="field-label">{t("vote.ckbAddress")}</span>
          <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`${network.network.hrp}1q…`} spellCheck={false} />
        </label>
        <button type="submit" className="btn">
          {t("vote.useAddress")}
        </button>
      </form>
      {!accepted && <Notice tone="bad">{t("vote.adapterNotAccepted", { adapter: ADAPTER_CKB })}</Notice>}
      {owner?.error !== null && owner?.error !== undefined && <ErrorView error={owner.error} />}
      {o && !supported && <Notice tone="bad">{t("vote.lockNotSupported", { kind: o.kind })}</Notice>}
      {o && supported && (
        <div className="small">
          <Mono value={o.lock.address} />
          {power.data && (
            <span className="muted">
              {" "}
              {t("vote.deposit", { amount: formatCkb(power.data.total_shannon), n: power.data.deposits.length })}
            </span>
          )}
          {power.error !== null && <ErrorView error={power.error} />}
          {power.data && big(power.data.total_shannon) === 0n && (
            <Notice tone="warn">{action === "CANCEL" ? t("vote.noDepositCancel") : t("vote.noDeposit")}</Notice>
          )}
        </div>
      )}
      {o && supported && accepted && (
        <BallotRunner
          key={`${o.lock.owner_id}:${action}`}
          core={core}
          network={network}
          manifest={manifest}
          detail={detail}
          entries={entries}
          action={action}
          signer={{ kind: "neuron", address: o.lock.address }}
        />
      )}
    </div>
  );
}

export function VotePanel({ core, network, detail }: { core: Core; network: NetworkInfo; detail: ProposalDetail }) {
  const { t } = useI18n();
  const [method, setMethod] = useState<"metamask" | "delegate" | "neuron">("metamask");
  const [action, setAction] = useState<Action>("YES");
  const open = detail.status === "OPEN";
  return (
    <div className="vote">
      {!open && (
        <Notice tone={detail.status === "ANNOUNCED" ? "info" : "warn"}>
          {detail.status === "ANNOUNCED" ? t("vote.notStarted", { start: utcHuman(detail.start_ms) }) : t("vote.closed")}
        </Notice>
      )}
      <ChoicePicker value={action} onChange={setAction} />
      <div className="tabs" role="tablist">
        {(["metamask", "delegate", "neuron"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={method === m}
            className={`tab${method === m ? " active" : ""}`}
            onClick={() => setMethod(m)}
          >
            {t(`vote.method.${m}`)}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {method === "metamask" && <OwnerWalletVote core={core} network={network} detail={detail} action={action} />}
        {method === "delegate" && <DelegateVote core={core} network={network} detail={detail} action={action} />}
        {method === "neuron" && <NeuronVote core={core} network={network} detail={detail} action={action} />}
      </div>
      <p className="muted small">{t("vote.weightNote")}</p>
    </div>
  );
}
