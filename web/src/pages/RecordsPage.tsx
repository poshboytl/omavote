import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { useWallet } from "../app/wallet";
import { CodeBadge } from "../components/badges";
import { NeedCore } from "../components/gate";
import { ReceiptNote, SignTextView, SyncIssues, useSyncCheck, WalletBar } from "../components/sign";
import { SubmissionTracker } from "../components/tracker";
import { Badge, Check, CopyButton, DownloadJsonButton, ErrorView, Field, JsonBlock, KV, Mono, Notice, Section, useErrorText } from "../components/ui";
import type { Core } from "../lib/core";
import {
  anchorAbove,
  checkReceipt,
  prepareRecord,
  processEnvelope,
  RECORD_ROLES,
  RECORD_TYPES,
  recordBody,
  recordDetail,
  roleMembers,
  submitEnvelope,
  validMemberSignatures,
  verifyKeySig,
  walletSigner,
  type MemberSignature,
  type PreparedRecord,
  type ReceiptCheck,
  type RecordDetailInput,
  type RoleMember,
  type SubmitOutcome,
} from "../lib/flow";
import { big, pollTag, utcHuman } from "../lib/format";
import { parseHash32, parseSignature } from "../lib/hex";
import { KEYS, readJson, savePending, writeJson } from "../lib/storage";
import type { NetworkInfo, ProcessRecordBody, RecordType, Role } from "../lib/types";

export function RecordsPage() {
  return <NeedCore>{(core, network) => <RecordsView core={core} network={network} />}</NeedCore>;
}

interface Draft {
  body: ProcessRecordBody;
  sigs: MemberSignature[];
}

function loadDraft(core: Core): { prepared: PreparedRecord; sigs: MemberSignature[] } | null {
  const d = readJson<Draft | null>(KEYS.recordDraft, null);
  if (!d) return null;
  try {
    return { prepared: prepareRecord(core, d.body), sigs: d.sigs ?? [] };
  } catch {
    return null;
  }
}

function RecordsView({ core, network }: { core: Core; network: NetworkInfo }) {
  const { t } = useI18n();
  const roles = network.current_roles;
  const [draft, setDraft] = useState<{ prepared: PreparedRecord; sigs: MemberSignature[] } | null>(() => loadDraft(core));
  useEffect(() => {
    writeJson(KEYS.recordDraft, draft ? { body: draft.prepared.body, sigs: draft.sigs } : null);
  }, [draft]);
  return (
    <div className="page">
      <h1>{t("recordsPage.title")}</h1>
      <p className="lead">{t("recordsPage.lead")}</p>
      {!roles ? (
        <Notice tone="bad">{t("recordsPage.noRoles")}</Notice>
      ) : (
        <>
          <RolesView core={core} network={network} />
          {!draft ? (
            <>
              <NewRecord core={core} network={network} onDraft={(prepared) => setDraft({ prepared, sigs: [] })} />
              <ImportDraft core={core} onDraft={(prepared, sigs) => setDraft({ prepared, sigs })} />
            </>
          ) : (
            <CollectAndSubmit
              core={core}
              network={network}
              prepared={draft.prepared}
              sigs={draft.sigs}
              setSigs={(sigs) => setDraft({ prepared: draft.prepared, sigs })}
              onDiscard={() => setDraft(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function RolesView({ core, network }: { core: Core; network: NetworkInfo }) {
  const { t } = useI18n();
  const roles = network.current_roles;
  if (!roles) return null;
  return (
    <Section title={t("recordsPage.rolesTitle")}>
      <KV rows={[["roles_hash", <code key="r">{roles.roles_hash}</code>]]} />
      {(["coordinator", "committee"] as Role[]).map((role) => (
        <div key={role}>
          <h3>
            {t(`role.${role}`)} · {t("recordsPage.threshold", { n: roles.object.roles[role].threshold, of: roles.object.roles[role].members.length })}
          </h3>
          <ul className="plain small">
            {roleMembers(core, roles.object, role, network.network).map((m) => (
              <li key={m.keyId}>
                <Badge tone="neutral">{m.descriptor.kind}</Badge> <Mono value={m.display ?? ""} copy={false} /> <span className="muted">key_id {m.keyId.slice(0, 14)}…</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function NewRecord({ core, network, onDraft }: { core: Core; network: NetworkInfo; onDraft: (p: PreparedRecord) => void }) {
  const { t, tk } = useI18n();
  const { api } = useApp();
  const sync = useSyncCheck();
  const proposals = useLoad(() => api.proposals(), [api]);
  const [type, setType] = useState<RecordType>("ADMISSION");
  const [role, setRole] = useState<Role>("coordinator");
  const [pollInput, setPollInput] = useState("");
  const [detail, setDetail] = useState<RecordDetailInput>({ decision: "ADMITTED", status: "HOLD_EXECUTION", outcome: "PASS" });
  const [evidence, setEvidence] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<{ current: string; floor: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const roles = network.current_roles;
  const allowedRoles = RECORD_ROLES[type];
  useEffect(() => {
    if (!allowedRoles.includes(role)) setRole(allowedRoles[0] ?? "committee");
  }, [type, allowedRoles, role]);
  const pollId = type === "ROLES_UPDATE" ? null : parseHash32(pollInput);
  const poll = proposals.data?.proposals.find((p) => p.poll_id === pollId) ?? null;
  // Prefill a result attestation from the server's computed FINAL tally (verify it first!).
  useEffect(() => {
    if (type === "RESULT_ATTESTATION" && poll?.tally?.kind === "FINAL") {
      setDetail((d) => ({ ...d, resultHash: poll.tally?.kind === "FINAL" ? poll.tally.result_hash : d.resultHash, outcome: poll.tally?.kind === "FINAL" ? poll.tally.outcome : d.outcome }));
    }
  }, [type, poll]);
  const problems: string[] = [];
  if (type !== "ROLES_UPDATE" && !pollId) problems.push(t("recordsPage.errPoll"));
  if (type === "NOTICE" && !/^[A-Z0-9_]{1,16}$/.test(detail.code ?? "")) problems.push(t("recordsPage.errCode"));
  if (type === "RESULT_ATTESTATION" && !parseHash32(detail.resultHash ?? "")) problems.push(t("recordsPage.errHash"));
  if (type === "EXECUTION" && !parseHash32(detail.txHash ?? "")) problems.push(t("recordsPage.errHash"));
  if (type === "ROLES_UPDATE" && !parseHash32(detail.newRolesHash ?? "")) problems.push(t("recordsPage.errHash"));
  if (evidence.trim() !== "" && !parseHash32(evidence)) problems.push(t("create.errHash"));

  const build = async () => {
    if (!roles) return;
    setBusy(true);
    setError(null);
    try {
      const a = await sync.check();
      if ((!a || !a.ok) && !ack) return;
      // Same poll and type at the same anchor with different content is a RECORD_CONFLICT:
      // anchor strictly above the existing records of this type.
      let floor: bigint | null = null;
      if (pollId) {
        const v = await api.records(pollId);
        for (const r of v.records) if (r.record_type === type && (floor === null || big(r.anchor_height) > floor)) floor = big(r.anchor_height);
      }
      const anchor = await anchorAbove(api, floor, { timeoutMs: 180_000, onWait: (c, f) => setWaiting({ current: c.number, floor: f.toString() }) });
      setWaiting(null);
      const d = recordDetail(type, {
        ...detail,
        resultHash: parseHash32(detail.resultHash ?? "") ?? undefined,
        txHash: parseHash32(detail.txHash ?? "") ?? undefined,
        newRolesHash: parseHash32(detail.newRolesHash ?? "") ?? undefined,
      });
      const body = recordBody({
        genesis: network.network.genesis_hash,
        rolesHash: roles.roles_hash,
        role,
        recordType: type,
        pollId,
        detail: d,
        evidenceHash: evidence.trim() === "" ? null : parseHash32(evidence),
        anchorHash: anchor.hash,
        publicationDeadlineMs: anchor.process_publication_deadline_ms,
        nonce: core.nonce(),
      });
      onDraft(prepareRecord(core, body));
    } catch (e) {
      setWaiting(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("recordsPage.newTitle")}>
      <div className="form-grid">
        <Field label={t("recordsPage.type")}>
          <select value={type} onChange={(e) => setType(e.target.value as RecordType)}>
            {RECORD_TYPES.map((x) => (
              <option key={x} value={x}>
                {tk(`recordType.${x}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("recordsPage.role")}>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {allowedRoles.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        {type !== "ROLES_UPDATE" && (
          <Field label={t("recordsPage.poll")} error={pollInput !== "" && !pollId ? t("recordsPage.errPoll") : undefined}>
            <select value={pollId ?? ""} onChange={(e) => setPollInput(e.target.value)}>
              <option value="">—</option>
              {proposals.data?.proposals.map((p) => (
                <option key={p.poll_id} value={p.poll_id}>
                  {pollTag(p.poll_id)} {p.title} ({tk(`pollStatus.${p.status}`)})
                </option>
              ))}
            </select>
            <input className="mono" value={pollInput} onChange={(e) => setPollInput(e.target.value)} placeholder="0x…" spellCheck={false} />
          </Field>
        )}
        {type === "ADMISSION" && (
          <Field label={t("recordsPage.decision")}>
            <select value={detail.decision} onChange={(e) => setDetail({ ...detail, decision: e.target.value as "ADMITTED" | "REJECTED" })}>
              <option value="ADMITTED">ADMITTED</option>
              <option value="REJECTED">REJECTED</option>
            </select>
          </Field>
        )}
        {type === "NOTICE" && (
          <Field label={t("recordsPage.code")} hint={t("recordsPage.codeHint")}>
            <input value={detail.code ?? ""} onChange={(e) => setDetail({ ...detail, code: e.target.value.toUpperCase() })} />
          </Field>
        )}
        {type === "GOVERNANCE_STATUS" && (
          <Field label={t("recordsPage.status")}>
            <select value={detail.status} onChange={(e) => setDetail({ ...detail, status: e.target.value as "HOLD_EXECUTION" | "CLEARED" | "VOIDED" })}>
              <option value="HOLD_EXECUTION">HOLD_EXECUTION</option>
              <option value="CLEARED">CLEARED</option>
              <option value="VOIDED">VOIDED</option>
            </select>
          </Field>
        )}
        {type === "RESULT_ATTESTATION" && (
          <>
            <Field label="result_hash" hint={t("recordsPage.resultHint")}>
              <input className="mono" value={detail.resultHash ?? ""} onChange={(e) => setDetail({ ...detail, resultHash: e.target.value })} spellCheck={false} />
            </Field>
            <Field label={t("recordsPage.outcome")}>
              <select value={detail.outcome} onChange={(e) => setDetail({ ...detail, outcome: e.target.value as "PASS" | "FAIL" })}>
                <option value="PASS">PASS</option>
                <option value="FAIL">FAIL</option>
              </select>
            </Field>
          </>
        )}
        {type === "EXECUTION" && (
          <Field label="tx_hash">
            <input className="mono" value={detail.txHash ?? ""} onChange={(e) => setDetail({ ...detail, txHash: e.target.value })} spellCheck={false} />
          </Field>
        )}
        {type === "ROLES_UPDATE" && (
          <Field label="new_roles_hash" hint={t("recordsPage.rolesUpdateHint")}>
            <input className="mono" value={detail.newRolesHash ?? ""} onChange={(e) => setDetail({ ...detail, newRolesHash: e.target.value })} spellCheck={false} />
          </Field>
        )}
        <Field label={t("recordsPage.evidence")} hint={t("create.optionalHash")}>
          <input className="mono" value={evidence} onChange={(e) => setEvidence(e.target.value)} spellCheck={false} />
        </Field>
      </div>
      {problems.map((p, i) => (
        <div key={i} className="field-err">
          {p}
        </div>
      ))}
      <SyncIssues assessment={sync.assessment} />
      {sync.assessment && !sync.assessment.ok && (
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t("sync.ack")}
        </label>
      )}
      <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0} onClick={() => void build()}>
        {busy ? t("vote.preparing") : t("recordsPage.build")}
      </button>
      {waiting && <Notice tone="info">{t("anchor.waiting", { current: waiting.current, floor: waiting.floor })}</Notice>}
      {error !== null && <ErrorView error={error} />}
    </Section>
  );
}

function ImportDraft({ core, onDraft }: { core: Core; onDraft: (p: PreparedRecord, sigs: MemberSignature[]) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Section title={t("recordsPage.importTitle")}>
      <p className="muted">{t("recordsPage.importLead")}</p>
      <textarea className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder='{"body": {...}, "proofs": [...]}' />
      <button
        type="button"
        className="btn"
        disabled={text.trim() === ""}
        onClick={() => {
          setError(null);
          try {
            const v = JSON.parse(text) as { body?: ProcessRecordBody; proofs?: { signer_key_id: string; proof: { signature: string } }[] } & Partial<ProcessRecordBody>;
            const body = (v.body ?? v) as ProcessRecordBody;
            const prepared = prepareRecord(core, body);
            const sigs = (v.proofs ?? []).map((p) => ({ signer_key_id: p.signer_key_id, signature: p.proof.signature }));
            onDraft(prepared, sigs);
          } catch (e) {
            setError(e);
          }
        }}
      >
        {t("recordsPage.import")}
      </button>
      {error !== null && <ErrorView error={error} />}
    </Section>
  );
}

function CollectAndSubmit({
  core,
  network,
  prepared,
  sigs,
  setSigs,
  onDiscard,
}: {
  core: Core;
  network: NetworkInfo;
  prepared: PreparedRecord;
  sigs: MemberSignature[];
  setSigs: (s: MemberSignature[]) => void;
  onDiscard: () => void;
}) {
  const { t, tk } = useI18n();
  const { api } = useApp();
  const w = useWallet();
  const errorText = useErrorText();
  const roles = network.current_roles;
  const body = prepared.body;
  const members: RoleMember[] = useMemo(() => (roles ? roleMembers(core, roles.object, body.role, network.network) : []), [core, roles, body.role, network.network]);
  const threshold = roles ? Number(roles.object.roles[body.role].threshold) : 0;
  const valid = validMemberSignatures(core, members, prepared.text, sigs);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ submit: SubmitOutcome; receipt: ReceiptCheck | null } | null>(null);
  const rolesMismatch = roles?.roles_hash !== body.roles_hash;
  const expired = big(network.at?.clock_ms ?? "0") >= big(body.publication_deadline_ms);
  const envelope = processEnvelope(
    body,
    sigs.filter((s) => valid.has(s.signer_key_id)),
  );
  const draftJson = { body, proofs: envelope.proofs };

  const addSig = (m: RoleMember, signature: string) => {
    const v = verifyKeySig(core, m.descriptor, prepared.text, signature);
    if (!v.ok) {
      setErrors({ ...errors, [m.keyId]: t("sig.verifyFailed", { detail: v.error ?? "" }) });
      return;
    }
    setErrors({ ...errors, [m.keyId]: "" });
    setSigs([...sigs.filter((s) => s.signer_key_id !== m.keyId), { signer_key_id: m.keyId, signature }]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      savePending({ id: prepared.recordId, kind: "process_record", label: `${prepared.summary}`, poll_id: body.poll_id, envelope, created_ms: Date.now() });
      const s = await submitEnvelope(core, api, envelope);
      const receipt = s.ok
        ? checkReceipt(core, s.item, {
            receiptKey: network.receipt_key,
            objectId: prepared.recordId,
            itemKind: "process_record",
            envelopeJcs: s.envelopeJcs,
            genesis: network.network.genesis_hash,
          })
        : null;
      setResult({ submit: s, receipt });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const newRolesHash = (body.detail as { new_roles_hash?: string }).new_roles_hash ?? null;
  return (
    <>
      <Section title={t("recordsPage.draftTitle")}>
        <KV
          rows={[
            [t("recordsPage.type"), tk(`recordType.${body.record_type}`)],
            [t("recordsPage.role"), t(`role.${body.role}`)],
            [t("recordsPage.poll"), body.poll_id ? <code key="p">{body.poll_id}</code> : "—"],
            ["record_id", <code key="r">{prepared.recordId}</code>],
            [t("recordsPage.deadline"), utcHuman(body.publication_deadline_ms)],
          ]}
        />
        {rolesMismatch && <Notice tone="bad">{t("recordsPage.rolesMismatch")}</Notice>}
        {expired && <Notice tone="bad">{t("recordsPage.expired")}</Notice>}
        <SignTextView req={prepared} />
        <p className="muted">{t("recordsPage.shareLead")}</p>
        <div className="row">
          <CopyButton text={JSON.stringify(draftJson)} label={t("recordsPage.copyDraft")} small={false} />
          <DownloadJsonButton filename={`omavote-record-${prepared.recordId.slice(2, 18)}.json`} value={draftJson} label={t("recordsPage.downloadDraft")} />
          <button type="button" className="btn btn-quiet" onClick={onDiscard}>
            {t("recordsPage.discard")}
          </button>
        </div>
      </Section>
      <Section title={t("recordsPage.sigsTitle", { have: valid.size, need: threshold })}>
        <WalletBar purpose={t("recordsPage.walletPurpose")} />
        <ul className="plain members">
          {members.map((m) => {
            const isEvm = m.descriptor.kind === "evm_eoa";
            const walletIsMember = isEvm && !!w.address && w.address.toLowerCase() === (m.descriptor as { address: string }).address;
            return (
              <li key={m.keyId} className="member">
                <div className="member-head">
                  <Check ok={valid.has(m.keyId) ? true : null}>
                    <Badge tone="neutral">{m.descriptor.kind}</Badge> <Mono value={m.display ?? m.keyId} copy={false} />
                  </Check>
                </div>
                {!valid.has(m.keyId) && (
                  <div className="member-sign">
                    {isEvm && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy || !walletIsMember || !w.provider}
                        title={walletIsMember ? undefined : t("recordsPage.connectMember")}
                        onClick={async () => {
                          if (!w.provider || !w.address) return;
                          setBusy(true);
                          setError(null);
                          try {
                            addSig(m, await walletSigner(w.provider, w.address)(prepared));
                          } catch (e) {
                            setError(e);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {t("recordsPage.signWallet")}
                      </button>
                    )}
                    {!isEvm && <p className="muted small">{t("recordsPage.neuronMember")}</p>}
                    <div className="row">
                      <input
                        className="mono grow"
                        placeholder={t("recordsPage.pasteSig")}
                        value={inputs[m.keyId] ?? ""}
                        onChange={(e) => setInputs({ ...inputs, [m.keyId]: e.target.value })}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          const p = parseSignature(inputs[m.keyId] ?? "", isEvm ? "evm" : "ckb");
                          if (!p.ok) setErrors({ ...errors, [m.keyId]: t("sig.invalidFormat", { error: p.error }) });
                          else addSig(m, p.signature);
                        }}
                      >
                        {t("neuron.verify")}
                      </button>
                    </div>
                    {errors[m.keyId] && <div className="field-err">{errors[m.keyId]}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {error !== null && error !== undefined && <Notice tone="bad">{errorText(error)}</Notice>}
        <JsonBlock value={envelope} summary={t("recordsPage.envelopeJson")} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || valid.size < threshold || rolesMismatch || expired || result?.submit.ok === true}
          onClick={() => void submit()}
        >
          {t("recordsPage.submit", { have: valid.size, need: threshold })}
        </button>
        {result && !result.submit.ok && (
          <Notice tone="bad" title={t("vote.rejectedByRelay")}>
            <CodeBadge code={result.submit.code} /> {result.submit.detail}
          </Notice>
        )}
        {result?.submit.ok && (
          <SubmissionTracker
            target={{ kind: "process_record", objectId: prepared.recordId, pollId: body.poll_id, newRolesHash }}
            initial={result.submit.item}
            receipt={result.receipt}
          />
        )}
        <ReceiptNote />
      </Section>
    </>
  );
}
