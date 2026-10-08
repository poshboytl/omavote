import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { useWallet } from "../app/wallet";
import { CodeBadge } from "../components/badges";
import { NeedCore } from "../components/gate";
import { NeuronSignBox, ReceiptNote, SignTextView, WalletBar } from "../components/sign";
import { SubmissionTracker } from "../components/tracker";
import { Badge, Check, DownloadJsonButton, ErrorView, Field, JsonBlock, KV, Mono, Notice, Section, useErrorText } from "../components/ui";
import type { Core } from "../lib/core";
import {
  ADAPTER_EVM,
  blockIntervalMs,
  checkReceipt,
  lockLabel,
  manifestDraft,
  manifestPayload,
  openingCheck,
  ownerAdapterFor,
  ownerFromAddress,
  sameScript,
  signingTitleProblem,
  signRequest,
  submitEnvelope,
  verifyOwnerSig,
  walletSigner,
  type ProposerSignature,
  type ReceiptCheck,
  type SubmitOutcome,
} from "../lib/flow";
import { big, ckbToShannon, durationText, formatCkb, fromUtcInputValue, isDec, pollTag, toUtcInputValue, utcHuman } from "../lib/format";
import { parseHash32 } from "../lib/hex";
import { savePending } from "../lib/storage";
import type { ForumImport, LockInfo, Manifest, ManifestInfo, NetworkInfo, RulesProfile, Script } from "../lib/types";

export function CreatePage() {
  return <NeedCore>{(core, network) => <CreateView core={core} network={network} />}</NeedCore>;
}

const U64_MAX = 18446744073709551615n;
const FALLBACK_BLOCK_MS = 10_000;

interface Built {
  manifest: Manifest;
  info: ManifestInfo;
}

function CreateView({ core, network }: { core: Core; network: NetworkInfo }) {
  const { t, lang } = useI18n();
  const { status, api } = useApp();
  const net = network.network;
  const isDevnet = net.name !== "mainnet" && net.name !== "testnet";

  // Chain pace sample for the opening estimate (first status seen on this page).
  const firstSample = useRef<{ number: string; clock_ms: string } | null>(null);
  if (!firstSample.current && status?.indexed) firstSample.current = status.indexed;
  const interval = blockIntervalMs(firstSample.current, status?.indexed ?? null);
  const blockMs = interval && interval > 0 ? interval : FALLBACK_BLOCK_MS;

  const [type, setType] = useState<"grant" | "meta_rule">("grant");
  const [title, setTitle] = useState("");
  const [signingTitle, setSigningTitle] = useState("");
  const [body, setBody] = useState("");
  const [hashOverride, setHashOverride] = useState("");
  const [locations, setLocations] = useState("");
  const [topic, setTopic] = useState("");
  const [revision, setRevision] = useState("1");
  const [evidence, setEvidence] = useState("");
  const [budget, setBudget] = useState("");
  const [quorumOverride, setQuorumOverride] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [recipient, setRecipient] = useState("");
  const [proposerText, setProposerText] = useState("");
  const [extraLocks, setExtraLocks] = useState<LockInfo[]>([]);
  const [start, setStart] = useState("");
  const [resultConf, setResultConf] = useState("100");
  const [reviewHours, setReviewHours] = useState("24");
  const [advOpening, setAdvOpening] = useState("");
  const [advPeriodMin, setAdvPeriodMin] = useState("");
  const [built, setBuilt] = useState<Built | null>(null);
  const [forumInput, setForumInput] = useState("");
  const [imported, setImported] = useState<ForumImport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<unknown>(null);
  const [buildError, setBuildError] = useState<unknown>(null);

  const rules: RulesProfile = useMemo(() => {
    if (isDevnet && (advOpening.trim() !== "" || advPeriodMin.trim() !== "")) {
      const opts: { opening_confirmations?: string; voting_period_ms?: string } = {};
      if (isDec(advOpening.trim())) opts.opening_confirmations = advOpening.trim();
      if (isDec(advPeriodMin.trim()) && advPeriodMin.trim() !== "0") opts.voting_period_ms = (BigInt(advPeriodMin.trim()) * 60_000n).toString();
      try {
        return core.defaultRules(opts).rules_profile;
      } catch {
        return network.default_rules.object;
      }
    }
    return network.default_rules.object;
  }, [isDevnet, advOpening, advPeriodMin, core, network.default_rules.object]);

  // Default start: enough room for the opening confirmations plus a margin.
  useEffect(() => {
    if (start !== "" || !status?.indexed) return;
    const lead = (Number(rules.opening_confirmations) + 40) * blockMs + 30 * 60_000;
    const ms = Math.ceil((Number(status.indexed.clock_ms) + lead) / 600_000) * 600_000;
    setStart(toUtcInputValue(ms));
  }, [status?.indexed, start, rules.opening_confirmations, blockMs]);

  const contentHash = useMemo(() => {
    if (hashOverride.trim() !== "") return parseHash32(hashOverride);
    return body === "" ? null : core.ckbHashText(body);
  }, [hashOverride, body, core]);

  const parseLock = (address: string): { lock: LockInfo | null; error: string | null } => {
    try {
      return { lock: ownerFromAddress(core, net, address).lock, error: null };
    } catch (e) {
      return { lock: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const recipientParsed = recipient.trim() === "" ? null : parseLock(recipient.trim());
  const proposerParsed = proposerText
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => ({ address: a, ...parseLock(a) }));
  const proposerLocks: LockInfo[] = [...proposerParsed.flatMap((p) => (p.lock ? [p.lock] : [])), ...extraLocks].filter(
    (l, i, arr) => arr.findIndex((x) => x.owner_id === l.owner_id) === i,
  );

  const budgetShannon = type === "grant" ? ckbToShannon(budget) : "0";
  const quorumShannon = type === "grant" ? (quorumOverride.trim() !== "" ? ckbToShannon(quorumOverride) : budgetShannon) : "0";
  const startMs = fromUtcInputValue(start);
  const errors: Record<string, string> = {};
  if (title.trim() === "") errors.title = t("create.errRequired");
  const stp = signingTitleProblem(signingTitle);
  if (stp) errors.signingTitle = t(stp as "err.signingTitleLength");
  if (!contentHash) errors.content = t("create.errContent");
  if (!isDec(topic)) errors.topic = t("create.errDecimal");
  if (!isDec(revision)) errors.revision = t("create.errDecimal");
  if (evidence.trim() !== "" && !parseHash32(evidence)) errors.evidence = t("create.errHash");
  if (paymentTerms.trim() !== "" && !parseHash32(paymentTerms)) errors.paymentTerms = t("create.errHash");
  if (type === "grant") {
    if (!budgetShannon || big(budgetShannon) === 0n) errors.budget = t("create.errAmount");
    else if (big(budgetShannon) > U64_MAX) errors.budget = t("create.errTooLarge");
    if (!quorumShannon || big(quorumShannon) === 0n) errors.quorum = t("create.errAmount");
    if (!recipientParsed?.lock) errors.recipient = recipientParsed?.error ?? t("create.errRequired");
  }
  for (const p of proposerParsed) if (p.error) errors.proposers = `${p.address}: ${p.error}`;
  if (proposerLocks.length === 0) errors.proposers = errors.proposers ?? t("create.errProposers");
  for (const l of proposerLocks) {
    const ad = ownerAdapterFor(net, l.script);
    if (!ad || !network.default_registry.object.owner_adapters.includes(ad)) errors.proposers = t("create.errProposerLock", { address: l.address });
  }
  if (startMs === null) errors.start = t("create.errStart");
  if (!isDec(resultConf)) errors.resultConf = t("create.errDecimal");
  if (!isDec(reviewHours)) errors.review = t("create.errDecimal");
  const valid = Object.keys(errors).length === 0;

  const opening =
    startMs !== null && status?.indexed
      ? openingCheck({
          startMs: String(startMs),
          chainClockMs: status.indexed.clock_ms,
          openingConfirmations: rules.opening_confirmations,
          blockIntervalMs: blockMs,
        })
      : null;

  const build = () => {
    setBuilt(null);
    setBuildError(null);
    try {
      const draft = manifestDraft({
        genesis: net.genesis_hash,
        nonce: core.nonce(),
        proposalType: type,
        title,
        signingTitle,
        contentHash: contentHash ?? "",
        contentLocations: locations
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        forumTopicId: topic,
        forumRevision: revision,
        discussionEvidenceHash: evidence.trim() === "" ? null : parseHash32(evidence),
        budgetShannon: budgetShannon ?? "0",
        quorumBaseShannon: quorumShannon ?? "0",
        paymentTermsHash: paymentTerms.trim() === "" ? null : parseHash32(paymentTerms),
        recipientLock: recipientParsed?.lock?.script ?? null,
        proposerLocks: proposerLocks.map((l) => l.script),
        rules,
        registry: network.default_registry.object,
        policy: network.authorization_policy.object,
        startMs: String(startMs ?? 0),
        resultConfirmations: resultConf,
        reviewWindowMs: (BigInt(reviewHours || "0") * 3_600_000n).toString(),
      });
      const out = core.manifestFromDraft(draft, net);
      setBuilt(out);
    } catch (e) {
      setBuildError(e);
    }
  };

  const invalidate = () => setBuilt(null);
  const wrap =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      invalidate();
    };

  return (
    <div className="page">
      <h1>{t("create.title")}</h1>
      <p className="lead">{t("create.lead")}</p>
      <Notice tone="info">{t("create.forumNote")}</Notice>
      {network.authorization_policy.published === null && <Notice tone="warn">{t("create.policyUnpublished")}</Notice>}

      <Section title={t("create.importTitle")}>
        <p>{t("create.importLead")}</p>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setImportBusy(true);
            setImportError(null);
            try {
              const d = await api.forumImport(forumInput);
              setImported(d);
              wrap(setTitle)(d.title);
              wrap(setBody)(d.content_raw);
              wrap(setHashOverride)("");
              wrap(setLocations)(d.source);
              wrap(setTopic)(d.topic_id);
              wrap(setRevision)(d.revision);
            } catch (err) {
              setImportError(err);
            } finally {
              setImportBusy(false);
            }
          }}
        >
          <input className="mono grow" value={forumInput} onChange={(e) => setForumInput(e.target.value)} placeholder="https://talk.nervos.org/t/…/12345" spellCheck={false} />
          <button type="submit" className="btn btn-primary" disabled={importBusy || forumInput.trim() === ""}>
            {t("create.importButton")}
          </button>
        </form>
        {importError !== null && <ErrorView error={importError} />}
        {imported && (
          <>
            <KV
              rows={[
                [t("create.importSource"), <a key="s" href={imported.source} rel="noreferrer noopener" target="_blank">{imported.source}</a>],
                [t("create.revision"), imported.revision],
                [t("create.importAuthor"), `${imported.author ?? "—"} · ${imported.updated_at ?? imported.created_at ?? ""}`],
                [t("create.importHash"), <code key="h">{imported.content_hash}</code>],
              ]}
            />
            {contentHash === imported.content_hash ? (
              <Check ok>{t("create.importMatches", { rev: imported.revision })}</Check>
            ) : (
              <Notice tone="warn">{t("create.importEdited", { rev: imported.revision })}</Notice>
            )}
            {imported.recipient_candidates.length > 0 && (
              <div className="small">
                {t("create.importCandidates")}{" "}
                {imported.recipient_candidates.map((a) => (
                  <button key={a} type="button" className="btn btn-small mono" onClick={() => wrap(setRecipient)(a)}>
                    {a.slice(0, 12)}…{a.slice(-8)}
                  </button>
                ))}
              </div>
            )}
            <Notice tone="warn">{t("create.importUnverified")}</Notice>
          </>
        )}
      </Section>

      <Section title={t("create.formTitle")}>
        <div className="form-grid">
          <Field label={t("create.type")}>
            <select value={type} onChange={(e) => wrap(setType)(e.target.value as "grant" | "meta_rule")}>
              <option value="grant">{t("proposal.typeGrant")}</option>
              <option value="meta_rule">{t("proposal.typeMeta")}</option>
            </select>
          </Field>
          <Field label={t("create.fullTitle")} error={errors.title}>
            <input value={title} onChange={(e) => wrap(setTitle)(e.target.value)} />
          </Field>
          <Field label={t("create.signingTitle")} hint={t("create.signingTitleHint", { n: [...signingTitle].length })} error={errors.signingTitle}>
            <input value={signingTitle} onChange={(e) => wrap(setSigningTitle)(e.target.value)} maxLength={200} />
          </Field>
          <Field label={t("create.body")} hint={t("create.bodyHint")} error={errors.content}>
            <textarea rows={8} value={body} onChange={(e) => wrap(setBody)(e.target.value)} />
          </Field>
          <Field label={t("create.contentHash")} hint={t("create.contentHashHint")}>
            <input className="mono" value={hashOverride} onChange={(e) => wrap(setHashOverride)(e.target.value)} placeholder={contentHash ?? "0x…"} spellCheck={false} />
          </Field>
          <div className="small">
            {t("create.computedHash")} <code>{contentHash ?? "—"}</code>
          </div>
          <Field label={t("create.locations")} hint={t("create.locationsHint")}>
            <textarea rows={2} className="mono" value={locations} onChange={(e) => wrap(setLocations)(e.target.value)} spellCheck={false} />
          </Field>
          <div className="row">
            <Field label={t("create.topic")} error={errors.topic}>
              <input inputMode="numeric" value={topic} onChange={(e) => wrap(setTopic)(e.target.value.trim())} />
            </Field>
            <Field label={t("create.revision")} error={errors.revision}>
              <input inputMode="numeric" value={revision} onChange={(e) => wrap(setRevision)(e.target.value.trim())} />
            </Field>
          </div>
          <Field label={t("create.evidence")} hint={t("create.optionalHash")} error={errors.evidence}>
            <input className="mono" value={evidence} onChange={(e) => wrap(setEvidence)(e.target.value)} spellCheck={false} />
          </Field>
          {type === "grant" && (
            <>
              <Field
                label={t("create.budget")}
                hint={budgetShannon ? t("create.budgetHint", { exact: formatCkb(budgetShannon), shannon: budgetShannon }) : t("create.budgetFormat")}
                error={errors.budget}
              >
                <input inputMode="decimal" value={budget} onChange={(e) => wrap(setBudget)(e.target.value)} placeholder="100000" />
              </Field>
              <Field label={t("create.quorumBase")} hint={t("create.quorumBaseHint")} error={errors.quorum}>
                <input inputMode="decimal" value={quorumOverride} onChange={(e) => wrap(setQuorumOverride)(e.target.value)} placeholder={budget || "="} />
              </Field>
              {quorumOverride.trim() !== "" && quorumShannon !== budgetShannon && <Notice tone="warn">{t("create.quorumWarn")}</Notice>}
              <Field label={t("create.paymentTerms")} hint={t("create.optionalHash")} error={errors.paymentTerms}>
                <input className="mono" value={paymentTerms} onChange={(e) => wrap(setPaymentTerms)(e.target.value)} spellCheck={false} />
              </Field>
              <Field label={t("create.recipient")} hint={t("create.recipientHint")} error={errors.recipient}>
                <input className="mono" value={recipient} onChange={(e) => wrap(setRecipient)(e.target.value)} placeholder={`${net.hrp}1q…`} spellCheck={false} />
              </Field>
            </>
          )}
          <Field label={t("create.proposers")} hint={t("create.proposersHint")} error={errors.proposers}>
            <textarea rows={2} className="mono" value={proposerText} onChange={(e) => wrap(setProposerText)(e.target.value)} spellCheck={false} />
          </Field>
          <ProposerFromWallet
            core={core}
            network={network}
            onAdd={(l) => {
              setExtraLocks((x) => (x.some((y) => y.owner_id === l.owner_id) ? x : [...x, l]));
              invalidate();
            }}
          />
          {proposerLocks.length > 0 && (
            <ul className="plain small">
              {proposerLocks.map((l) => (
                <li key={l.owner_id}>
                  <Badge tone="neutral">{lockLabel(net, l.script)}</Badge> <Mono value={l.address} copy={false} />
                  {extraLocks.some((x) => x.owner_id === l.owner_id) && (
                    <button
                      type="button"
                      className="btn btn-small btn-quiet"
                      onClick={() => {
                        setExtraLocks((x) => x.filter((y) => y.owner_id !== l.owner_id));
                        invalidate();
                      }}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Field label={t("create.start")} hint={t("create.startHint")} error={errors.start}>
            <input type="datetime-local" step={60} value={start} onChange={(e) => wrap(setStart)(e.target.value)} />
          </Field>
          <div className="small">
            {t("create.window", {
              start: startMs !== null ? utcHuman(startMs) : "—",
              end: startMs !== null ? utcHuman(startMs + Number(rules.voting_period_ms)) : "—",
              period: durationText(Number(rules.voting_period_ms), lang),
            })}
          </div>
          <div className="row">
            <Field label={t("create.resultConfirmations")} error={errors.resultConf}>
              <input inputMode="numeric" value={resultConf} onChange={(e) => wrap(setResultConf)(e.target.value.trim())} />
            </Field>
            <Field label={t("create.reviewHours")} error={errors.review}>
              <input inputMode="numeric" value={reviewHours} onChange={(e) => wrap(setReviewHours)(e.target.value.trim())} />
            </Field>
          </div>
          {isDevnet && (
            <details className="advanced">
              <summary>{t("create.advanced")}</summary>
              <Notice tone="warn">{t("create.advancedWarn")}</Notice>
              <div className="row">
                <Field label={t("create.openingConfirmations")}>
                  <input inputMode="numeric" value={advOpening} onChange={(e) => wrap(setAdvOpening)(e.target.value.trim())} placeholder={network.default_rules.object.opening_confirmations} />
                </Field>
                <Field label={t("create.periodMinutes")}>
                  <input inputMode="numeric" value={advPeriodMin} onChange={(e) => wrap(setAdvPeriodMin)(e.target.value.trim())} placeholder={String(Number(network.default_rules.object.voting_period_ms) / 60_000)} />
                </Field>
              </div>
            </details>
          )}
        </div>
        <RulesSummary rules={rules} />
        {opening && !opening.ok && (
          <Notice tone="bad" title={t("create.openingTitle")}>
            {t("create.openingBody", {
              blocks: opening.requiredBlocks,
              need: durationText(opening.requiredMs, lang),
              have: durationText(Math.max(0, opening.availableMs), lang),
              interval: Math.round(blockMs / 100) / 10,
            })}
          </Notice>
        )}
        {opening?.ok && (
          <Notice tone="info">
            {t("create.openingOk", { blocks: opening.requiredBlocks, interval: Math.round(blockMs / 100) / 10 })}
          </Notice>
        )}
        <button type="button" className="btn btn-primary" disabled={!valid} onClick={build}>
          {t("create.build")}
        </button>
        {!valid && <p className="muted small">{t("create.fixErrors")}</p>}
        {buildError !== null && <ErrorView error={buildError} />}
      </Section>
      {built && <SignAndSubmit core={core} network={network} built={built} proposerLocks={proposerLocks} />}
    </div>
  );
}

function RulesSummary({ rules }: { rules: RulesProfile }) {
  const { t, lang } = useI18n();
  return (
    <details className="rules">
      <summary>{t("create.rulesTitle")}</summary>
      <KV
        rows={[
          [t("proposal.approval"), `${rules.approval_grant.numerator}/${rules.approval_grant.denominator} (grant), ${rules.approval_meta_rule.numerator}/${rules.approval_meta_rule.denominator} (meta-rule), ${rules.threshold_comparison}`],
          [t("proposal.quorum"), t("create.rulesQuorum", { mult: rules.quorum_grant_multiplier, meta: formatCkb(rules.quorum_meta_rule_shannon) })],
          [t("schedule.period"), durationText(Number(rules.voting_period_ms), lang)],
          [t("schedule.openingConfirmations"), rules.opening_confirmations],
          [t("create.proposerMin"), formatCkb(rules.proposer_min_deposit_shannon)],
        ]}
      />
      <p className="muted small">{t("create.rulesNote")}</p>
    </details>
  );
}

function ProposerFromWallet({ core, network, onAdd }: { core: Core; network: NetworkInfo; onAdd: (l: LockInfo) => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const locks = useMemo(() => {
    if (!w.address) return [];
    try {
      return core.evmOwnerLocks(network.network, w.address);
    } catch {
      return [];
    }
  }, [w.address, core, network]);
  return (
    <details className="evm-owner">
      <summary>{t("create.proposerWallet")}</summary>
      <WalletBar />
      {locks.map((l) => (
        <div key={l.owner_id} className="row small">
          <Badge tone="neutral">{lockLabel(network.network, l.script)}</Badge> <code>{l.address}</code>
          <button type="button" className="btn btn-small" onClick={() => onAdd(l)}>
            {t("create.addProposer")}
          </button>
        </div>
      ))}
    </details>
  );
}

function SignAndSubmit({ core, network, built, proposerLocks }: { core: Core; network: NetworkInfo; built: Built; proposerLocks: LockInfo[] }) {
  const { t } = useI18n();
  const { api } = useApp();
  const w = useWallet();
  const errorText = useErrorText();
  const net = network.network;
  const { manifest, info } = built;
  const [sigs, setSigs] = useState<ProposerSignature[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ submit: SubmitOutcome; receipt: ReceiptCheck | null } | null>(null);
  const [powers, setPowers] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void Promise.all(
      manifest.proposer_owner_locks.map(async (l) => {
        const id = core.scriptHash(l);
        try {
          return [id, (await api.ownerPower(id)).total_shannon] as const;
        } catch {
          return [id, "0"] as const;
        }
      }),
    ).then((entries) => live && setPowers(Object.fromEntries(entries)));
    return () => {
      live = false;
    };
  }, [api, core, manifest]);
  const totalDeposit = Object.values(powers).reduce((a, b) => a + big(b), 0n);
  const minDeposit = big(manifest.rules_profile.proposer_min_deposit_shannon);

  const signed = (lock: Script) => sigs.find((s) => sameScript(s.owner_lock, lock)) ?? null;
  const addSig = (lock: Script, adapter: string, signature: string) =>
    setSigs((prev) => [...prev.filter((s) => !sameScript(s.owner_lock, lock)), { owner_lock: lock, auth_adapter: adapter, signature }]);
  const allSigned = manifest.proposer_owner_locks.every((l) => signed(l) !== null);
  const payload = allSigned ? manifestPayload(manifest, sigs) : null;

  const submit = async () => {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      savePending({ id: info.poll_id, kind: "manifest", label: `${pollTag(info.poll_id)} ${manifest.title}`, poll_id: info.poll_id, envelope: payload, created_ms: Date.now() });
      const s = await submitEnvelope(core, api, payload);
      const receipt = s.ok
        ? checkReceipt(core, s.item, { receiptKey: network.receipt_key, objectId: info.poll_id, itemKind: "manifest", envelopeJcs: s.envelopeJcs, genesis: net.genesis_hash })
        : null;
      setResult({ submit: s, receipt });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title={t("create.builtTitle")}>
        <div className="poll-id-big">{pollTag(info.poll_id)}</div>
        <KV
          rows={[
            ["poll_id", <code key="p">{info.poll_id}</code>],
            [t("proposal.type"), manifest.proposal_type === "meta_rule" ? t("proposal.typeMeta") : t("proposal.typeGrant")],
            [t("proposal.budget"), manifest.proposal_type === "meta_rule" ? t("proposal.noBudget") : formatCkb(manifest.budget_ckb_shannon)],
            [t("proposal.quorum"), formatCkb(info.quorum_required_shannon)],
            [t("proposal.recipient"), info.recipient_address ? <Mono key="r" value={info.recipient_address} /> : "—"],
            [t("schedule.start"), info.start_utc],
            [t("schedule.end"), info.end_utc],
            ["rules_hash", <code key="rh">{info.rules_hash}</code>],
          ]}
        />
        <Check ok={totalDeposit >= minDeposit}>
          {t("create.proposerDeposit", { amount: formatCkb(totalDeposit), min: formatCkb(minDeposit) })}
        </Check>
        <JsonBlock value={manifest} summary={t("proposal.manifestJson")} />
      </Section>
      <Section title={t("create.signTitle", { n: manifest.proposer_owner_locks.length })}>
        <p className="muted">{t("create.signLead")}</p>
        {manifest.proposer_owner_locks.map((lock) => {
          const adapter = ownerAdapterFor(net, lock) ?? "";
          const address = proposerLocks.find((l) => sameScript(l.script, lock))?.address ?? core.address(net, lock);
          const text = core.proposalText(net, manifest, lock);
          const req = signRequest(text);
          const done = signed(lock);
          const walletOk =
            adapter === ADAPTER_EVM && !!w.address && core.evmOwnerLocks(net, w.address).some((l) => sameScript(l.script, lock));
          return (
            <div className="job" key={lock.args + lock.code_hash}>
              <div className="job-head">
                <strong>{t("create.proposer")}</strong> <Mono value={address} copy={false} /> <Badge tone="neutral">{lockLabel(net, lock)}</Badge>
              </div>
              <SignTextView req={req} />
              {done ? (
                <Check ok={true}>{t("sig.verifiedLocally")}</Check>
              ) : adapter === ADAPTER_EVM ? (
                <div>
                  <WalletBar />
                  {w.address && !walletOk && <Notice tone="bad">{t("control.walletMismatch")}</Notice>}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !walletOk || !w.provider}
                    onClick={async () => {
                      if (!w.provider || !w.address) return;
                      setBusy(true);
                      setError(null);
                      try {
                        const sig = await walletSigner(w.provider, w.address)(req);
                        const v = verifyOwnerSig(core, net, adapter, lock, text, sig);
                        if (!v.ok) throw new Error(t("sig.verifyFailed", { detail: v.error ?? "" }));
                        addSig(lock, adapter, sig);
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("create.signWallet")}
                  </button>
                </div>
              ) : (
                <NeuronSignBox
                  req={req}
                  address={address}
                  verify={(sig) => verifyOwnerSig(core, net, adapter, lock, text, sig)}
                  onVerified={(sig) => addSig(lock, adapter, sig)}
                />
              )}
            </div>
          );
        })}
        {error !== null && error !== undefined && <Notice tone="bad">{errorText(error)}</Notice>}
      </Section>
      {payload && (
        <Section title={t("create.submitTitle")}>
          <JsonBlock value={payload} summary={t("create.payloadJson")} />
          <div className="row">
            <DownloadJsonButton filename={`omavote-manifest-${info.short_id}.json`} value={payload} />
            <button type="button" className="btn btn-primary" disabled={busy || result?.submit.ok === true} onClick={() => void submit()}>
              {t("create.submit")}
            </button>
          </div>
          {result && !result.submit.ok && (
            <Notice tone="bad" title={t("vote.rejectedByRelay")}>
              <CodeBadge code={result.submit.code} /> {result.submit.detail}
            </Notice>
          )}
          {result?.submit.ok && (
            <SubmissionTracker target={{ kind: "manifest", objectId: info.poll_id }} initial={result.submit.item} receipt={result.receipt} />
          )}
          <Notice tone="info">{t("create.afterSubmit")}</Notice>
          <ReceiptNote />
        </Section>
      )}
    </>
  );
}
