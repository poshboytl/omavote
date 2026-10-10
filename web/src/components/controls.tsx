import { useMemo, useState } from "react";
import { useExtension } from "../app/extension";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { useWallet } from "../app/wallet";
import type { Core } from "../lib/core";
import {
  ADAPTER_EVM,
  anchorAbove,
  checkReceipt,
  controlBody,
  controlEnvelope,
  controlSequence,
  DEFAULT_TERM_DAYS,
  fetchControlFloor,
  grantExpiry,
  MAX_TERM_DAYS,
  parseKeyInput,
  prepareControl,
  sameScript,
  submitEnvelope,
  TERM_PRESETS,
  verifyOwnerSig,
  walletSigner,
  type PreparedControl,
  type SubmitOutcome,
  type ReceiptCheck,
} from "../lib/flow";
import { utcHuman } from "../lib/format";
import { lastAnchor, listPending, rememberAnchor, savePending } from "../lib/storage";
import type { ControlBody, ControlEnvelope, KeyInfo, LockInfo, NetworkInfo, RevokeMode, StreamView } from "../lib/types";
import { CodeBadge } from "./badges";
import { NeuronSignBox, ReceiptNote, SignTextView, SyncIssues, useSyncCheck, WalletBar } from "./sign";
import { SubmissionTracker } from "./tracker";
import { Check, DownloadJsonButton, ErrorView, Field, Mono, Notice, useErrorText } from "./ui";

export type ControlMode = "GRANT" | "GRANT_CANCEL" | "REVOKE_CANCEL" | "REVOKE_STOP";

const MODES: ControlMode[] = ["GRANT", "GRANT_CANCEL", "REVOKE_CANCEL", "REVOKE_STOP"];

function modeParts(m: ControlMode): { action: "GRANT" | "REVOKE"; revokeMode: RevokeMode | null } {
  switch (m) {
    case "GRANT":
      return { action: "GRANT", revokeMode: null };
    case "GRANT_CANCEL":
      return { action: "GRANT", revokeMode: "STOP_AND_CANCEL_OPEN" };
    case "REVOKE_CANCEL":
      return { action: "REVOKE", revokeMode: "STOP_AND_CANCEL_OPEN" };
    case "REVOKE_STOP":
      return { action: "REVOKE", revokeMode: "STOP_ONLY" };
  }
}

/** Recovery-type controls refuse to be prepared while the server is behind (docs/11 §5). */
function strictSync(m: ControlMode): boolean {
  return m !== "GRANT";
}

/**
 * GRANT / GRANT+CANCEL / REVOKE for one owner lock. Owner adapters only: an EVM
 * owner signs with MetaMask, a secp256k1 owner with Neuron (copy-paste).
 */
export function ControlPanel({
  core,
  network,
  lock,
  adapter,
  stream,
  onDone,
}: {
  core: Core;
  network: NetworkInfo;
  lock: LockInfo;
  adapter: string;
  stream: StreamView | null;
  onDone?: () => void;
}) {
  const { t, lang } = useI18n();
  const { api } = useApp();
  const w = useWallet();
  const x = useExtension();
  const extKey = x.key?.descriptor.kind === "secp256k1" ? x.key.descriptor.public_key : null;
  const errorText = useErrorText();
  const sync = useSyncCheck();
  const net = network.network;
  const [mode, setMode] = useState<ControlMode>("GRANT");
  const [keyInput, setKeyInput] = useState("");
  const [term, setTerm] = useState<number>(DEFAULT_TERM_DAYS);
  const [customTerm, setCustomTerm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<{ current: string; floor: string } | null>(null);
  const [prepared, setPrepared] = useState<{ p: PreparedControl; anchorNumber: string } | null>(null);
  const [result, setResult] = useState<{ envelope: ControlEnvelope; submit: SubmitOutcome; receipt: ReceiptCheck | null } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { action, revokeMode } = modeParts(mode);
  const policy = useMemo(() => core.authPolicy(net.genesis_hash), [core, net.genesis_hash]);
  const policyMismatch = policy.hash !== network.authorization_policy.hash;
  const policyPublished = network.authorization_policy.published !== null;

  const key: { info: KeyInfo | null; error: string | null } = useMemo(() => {
    if (action !== "GRANT" || keyInput.trim() === "") return { info: null, error: null };
    const d = parseKeyInput(keyInput);
    if (!d) return { info: null, error: t("control.badKey") };
    try {
      return { info: core.key(d, net), error: null };
    } catch (e) {
      return { info: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [action, keyInput, core, net, t]);

  const termDays = customTerm.trim() !== "" ? Number(customTerm) : term;
  const termOk = Number.isInteger(termDays) && termDays >= 1 && termDays <= MAX_TERM_DAYS;

  // docs/11 §5 step 6: after a separate safe revocation, a new GRANT must wait until
  // the revocation is confirmed effective (otherwise it could make it stale).
  // A revocation signed here is "pending" until the index shows an outcome for it, as
  // long as it can still be published (its publication deadline has not passed).
  const pendingRevoke = useMemo(() => {
    const clock = BigInt(network.at?.clock_ms ?? "0");
    const mine = listPending().filter(
      (p) => p.kind === "authorization_control" && p.owner_id === lock.owner_id && (p.envelope as ControlEnvelope)?.body?.action === "REVOKE",
    );
    return (
      mine.find((p) => {
        const body = (p.envelope as ControlEnvelope).body;
        const indexed = stream?.history.some((h) => h.authorization_id === p.id) ?? false;
        return !indexed && BigInt(body.publication_deadline_ms) > clock;
      }) ?? null
    );
  }, [lock.owner_id, stream, network.at?.clock_ms]);
  // GRANT+CANCEL sets its own barrier, so only a plain GRANT has to wait (docs/11 §5 step 6).
  const grantBlockedByRevoke = mode === "GRANT" && pendingRevoke !== null;

  const isEvmOwner = adapter === ADAPTER_EVM;
  const walletMatches = useMemo(() => {
    if (!isEvmOwner || !w.address) return false;
    try {
      return core.evmOwnerLocks(net, w.address).some((l) => sameScript(l.script, lock.script));
    } catch {
      return false;
    }
  }, [isEvmOwner, w.address, core, net, lock.script]);

  const reset = () => {
    setPrepared(null);
    setResult(null);
    setVerifyError(null);
    setError(null);
  };

  const prepare = async () => {
    reset();
    setBusy(true);
    try {
      const a = await sync.check();
      if (!a || !a.ok) {
        if (strictSync(mode) || !ack) return;
      }
      const local = lastAnchor(controlSequence(lock.owner_id));
      const { floor } = await fetchControlFloor(api, lock.owner_id, policy.hash, local);
      const anchor = await anchorAbove(api, floor, {
        timeoutMs: 180_000,
        onWait: (cur, fl) => setWaiting({ current: cur.number, floor: fl.toString() }),
      });
      setWaiting(null);
      const body: ControlBody = controlBody({
        genesis: net.genesis_hash,
        policyHash: policy.hash,
        ownerLock: lock.script,
        ownerAdapter: adapter,
        action,
        keyDescriptor: action === "GRANT" ? key.info?.descriptor ?? null : null,
        expiresAtMs: action === "GRANT" ? grantExpiry(anchor.clock_ms, termDays) : null,
        revokeMode,
        anchorHash: anchor.hash,
        publicationDeadlineMs: anchor.control_publication_deadline_ms,
        nonce: core.nonce(),
      });
      setPrepared({ p: prepareControl(core, net, body), anchorNumber: anchor.number });
    } catch (e) {
      setWaiting(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const submitSigned = async (signature: string) => {
    if (!prepared) return;
    const v = verifyOwnerSig(core, net, adapter, lock.script, prepared.p.text, signature);
    if (!v.ok) {
      setVerifyError(v.error ?? "");
      return;
    }
    setVerifyError(null);
    const envelope = controlEnvelope(prepared.p.body, signature);
    rememberAnchor(controlSequence(lock.owner_id), { hash: prepared.p.body.anchor_block_hash, number: prepared.anchorNumber });
    savePending({
      id: prepared.p.authorizationId,
      kind: "authorization_control",
      label: `${prepared.p.summary} · ${lock.address}`,
      owner_id: lock.owner_id,
      envelope,
      created_ms: Date.now(),
    });
    setBusy(true);
    try {
      const submit = await submitEnvelope(core, api, envelope);
      const receipt = submit.ok
        ? checkReceipt(core, submit.item, {
            receiptKey: network.receipt_key,
            objectId: prepared.p.authorizationId,
            itemKind: "authorization_control",
            envelopeJcs: submit.envelopeJcs,
            genesis: net.genesis_hash,
          })
        : null;
      setResult({ envelope, submit, receipt });
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const signWithWallet = async () => {
    if (!prepared || !w.provider || !w.address) return;
    setBusy(true);
    setError(null);
    try {
      const sig = await walletSigner(w.provider, w.address)(prepared.p);
      setBusy(false);
      await submitSigned(sig);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const keyReady = action !== "GRANT" || key.info !== null;
  const canPrepare = !busy && keyReady && termOk && !grantBlockedByRevoke && !policyMismatch;
  return (
    <div className="control-panel">
      <fieldset className="modes">
        <legend>{t("control.mode")}</legend>
        {MODES.map((m) => (
          <label key={m} className={`mode${mode === m ? " selected" : ""}`}>
            <input
              type="radio"
              name={`mode-${lock.owner_id}`}
              checked={mode === m}
              onChange={() => {
                setMode(m);
                reset();
              }}
            />
            <span className="mode-title">{t(`control.mode.${m}`)}</span>
            <span className="mode-help">{t(`control.modeHelp.${m}`)}</span>
          </label>
        ))}
      </fieldset>

      {action === "GRANT" && (
        <div className="grant-fields">
          <Field label={t("control.key")} hint={t("control.keyHint")} error={key.error ?? undefined}>
            <input
              className="mono"
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                reset();
              }}
              placeholder="0x… (EVM address) / 0x02… (secp256k1 public key)"
              spellCheck={false}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn btn-small"
              disabled={!w.address}
              onClick={() => {
                if (w.address) setKeyInput(w.address);
                reset();
              }}
            >
              {t("control.useWalletKey")}
            </button>
            {!w.address && <span className="muted small">{t("control.connectForKey")}</span>}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-small"
              disabled={!extKey}
              onClick={() => {
                if (extKey) setKeyInput(extKey);
                reset();
              }}
            >
              {t("control.useExtensionKey")}
            </button>
            {/* docs/19 §3.7: a reset extension key replaces the old one and cancels its open ballots. */}
            <button
              type="button"
              className="btn btn-small"
              disabled={!extKey}
              onClick={() => {
                if (extKey) setKeyInput(extKey);
                setMode("GRANT_CANCEL");
                reset();
              }}
            >
              {t("control.extensionRecover")}
            </button>
            {!extKey && <span className="muted small">{t("control.connectExtensionForKey")}</span>}
          </div>
          {key.info && (
            <Notice tone="info" title={t("control.keyCheckTitle")}>
              <div>
                {t("control.keyDisplay")} <Mono value={key.info.key_display ?? ""} />
              </div>
              <div>
                {t("control.keyShort")} <code>{key.info.key_short}</code>
              </div>
              <div className="small muted">key_id {key.info.key_id}</div>
              <p className="small">{t("control.keyCompare")}</p>
            </Notice>
          )}
          <Field label={t("control.term")} hint={t("control.termHint", { max: MAX_TERM_DAYS })} error={termOk ? undefined : t("err.term")}>
            <div className="row">
              {TERM_PRESETS.map((d) => (
                <label key={d} className="inline-field">
                  <input
                    type="radio"
                    name={`term-${lock.owner_id}`}
                    checked={customTerm === "" && term === d}
                    onChange={() => {
                      setTerm(d);
                      setCustomTerm("");
                      reset();
                    }}
                  />
                  {t("control.days", { n: d })}
                </label>
              ))}
              <input
                className="narrow"
                inputMode="numeric"
                value={customTerm}
                onChange={(e) => {
                  setCustomTerm(e.target.value.replace(/[^0-9]/g, ""));
                  reset();
                }}
                placeholder={t("control.customDays")}
              />
            </div>
          </Field>
          <Notice tone="info">{t("control.separateAccount")}</Notice>
        </div>
      )}

      {!policyPublished && <Notice tone="warn">{t("control.policyUnpublished")}</Notice>}
      {policyMismatch && <Notice tone="bad">{t("control.policyMismatch")}</Notice>}
      {grantBlockedByRevoke && <Notice tone="bad">{t("control.waitRevoke")}</Notice>}
      <SyncIssues assessment={sync.assessment} strict={strictSync(mode)} />
      {sync.assessment && !sync.assessment.ok && !strictSync(mode) && (
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t("sync.ack")}
        </label>
      )}
      {!prepared && (
        <button type="button" className="btn btn-primary" disabled={!canPrepare} onClick={() => void prepare()}>
          {busy ? t("vote.preparing") : t("control.prepare", { mode: t(`control.mode.${mode}`) })}
        </button>
      )}
      {waiting && <Notice tone="info">{t("anchor.waiting", { current: waiting.current, floor: waiting.floor })}</Notice>}
      {error !== null && error !== undefined && <ErrorView error={error} />}

      {prepared && (
        <div className="job">
          <Notice tone="info" title={t("control.meaningTitle")}>
            {action === "GRANT"
              ? t(revokeMode ? "control.meaningGrantCancel" : "control.meaningGrant", {
                  key: key.info?.key_display ?? "",
                  until: utcHuman(prepared.p.body.expires_at_ms ?? "0"),
                })
              : t(revokeMode === "STOP_ONLY" ? "control.meaningRevokeStop" : "control.meaningRevokeCancel")}
            <div className="small muted">
              {t("control.publishBefore", { deadline: utcHuman(prepared.p.body.publication_deadline_ms), lang })}
            </div>
          </Notice>
          <SignTextView req={prepared.p} />
          {!result && isEvmOwner && (
            <div>
              <WalletBar purpose={t("control.walletPurpose")} />
              {w.address && !walletMatches && <Notice tone="bad">{t("control.walletMismatch")}</Notice>}
              <button type="button" className="btn btn-primary" disabled={busy || !walletMatches} onClick={() => void signWithWallet()}>
                {busy ? t("vote.signing") : t("control.signWallet")}
              </button>
            </div>
          )}
          {!result && !isEvmOwner && (
            <NeuronSignBox
              req={prepared.p}
              address={lock.address}
              verify={(sig) => verifyOwnerSig(core, net, adapter, lock.script, prepared.p.text, sig)}
              onVerified={(sig) => void submitSigned(sig)}
              disabled={busy}
              submits
            />
          )}
          {verifyError !== null && <Check ok={false}>{t("sig.verifyFailed", { detail: verifyError })}</Check>}
          {result && <Check ok={true}>{t("sig.verifiedLocally")}</Check>}
          {result && !result.submit.ok && (
            <Notice tone="bad" title={t("vote.rejectedByRelay")}>
              <CodeBadge code={result.submit.code} /> {result.submit.detail}
            </Notice>
          )}
          {result && !result.submit.ok && (
            <button type="button" className="btn" disabled={busy} onClick={() => void submitSigned(result.envelope.proof.signature)}>
              {t("vote.resubmit")}
            </button>
          )}
          {result?.submit.ok && (
            <SubmissionTracker
              target={{
                kind: "authorization_control",
                objectId: prepared.p.authorizationId,
                ownerId: lock.owner_id,
                policyHash: policy.hash,
                controlAction: action,
              }}
              initial={result.submit.item}
              receipt={result.receipt}
            />
          )}
          {result && (
            <DownloadJsonButton
              filename={`omavote-control-${prepared.p.authorizationId.slice(2, 18)}.json`}
              value={result.envelope}
              label={t("vote.downloadEnvelope")}
            />
          )}
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={reset}>
            {t("vote.startOver")}
          </button>
          {error !== null && error !== undefined && <Notice tone="bad">{errorText(error)}</Notice>}
          <ReceiptNote />
        </div>
      )}
    </div>
  );
}
