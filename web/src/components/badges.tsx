import { useI18n } from "../app/i18n";
import type { AdmissionState, AttestationState, GovernanceState } from "../lib/types";
import { Badge, type Tone } from "./ui";

const POLL_TONE: Record<string, Tone> = {
  ANNOUNCED: "info",
  OPEN: "ok",
  CLOSED_UNCONFIRMED: "warn",
  AUDITABLE: "info",
  FINALIZED_BY_POLICY: "neutral",
  EXECUTED: "neutral",
  DISPUTED: "bad",
  LATE_MANIFEST: "bad",
};

export function PollStatusBadge({ status }: { status: string }) {
  const { tk, th } = useI18n();
  return (
    <Badge tone={POLL_TONE[status] ?? "neutral"} title={th(`pollHelp.${status}`)}>
      {tk(`pollStatus.${status}`)}
    </Badge>
  );
}

export function AdmissionBadge({ v }: { v: AdmissionState }) {
  const { tk, th } = useI18n();
  const tone: Tone = v.state === "ADMITTED" ? "ok" : v.state === "PENDING" ? "info" : "bad";
  return (
    <Badge tone={tone} title={th(`admissionHelp.${v.state}`)}>
      {tk(`admission.${v.state}`)}
    </Badge>
  );
}

export function GovernanceBadge({ v }: { v: GovernanceState }) {
  const { tk, th } = useI18n();
  if (v.state === "NONE") return null;
  const tone: Tone = v.state === "CLEARED" ? "ok" : v.state === "VOIDED" ? "bad" : "warn";
  return (
    <Badge tone={tone} title={th(`governanceHelp.${v.state}`)}>
      {tk(`governance.${v.state}`)}
    </Badge>
  );
}

export function AttestationBadge({ v }: { v: AttestationState }) {
  const { tk, th } = useI18n();
  if (v.state === "NONE") return null;
  const tone: Tone = v.state === "CONFIRMED" ? "ok" : "bad";
  return (
    <Badge tone={tone} title={v.state === "DISPUTED" ? v.detail : th(`attestationHelp.${v.state}`)}>
      {tk(`attestation.${v.state}`)}
    </Badge>
  );
}

const BALLOT_TONE: Record<string, Tone> = {
  SELECTED: "ok",
  SUPERSEDED: "neutral",
  CONFLICT: "bad",
  CANCELLED_BY_CONTROL: "warn",
  OVERRIDDEN_BY_OWNER: "neutral",
};

export function BallotStatusBadge({ status }: { status: string }) {
  const { tk, th } = useI18n();
  return (
    <Badge tone={BALLOT_TONE[status] ?? "neutral"} title={th(`ballotHelp.${status}`)}>
      {tk(`ballotStatus.${status}`)}
    </Badge>
  );
}

const RELAY_TONE: Record<string, Tone> = {
  RECEIVED: "info",
  BROADCAST: "info",
  INCLUDED: "ok",
  CONFIRMED: "ok",
  EXPIRED: "bad",
  FAILED: "bad",
  ALREADY_ON_CHAIN: "ok",
};

export function RelayStatusBadge({ status }: { status: string }) {
  const { tk, th } = useI18n();
  return (
    <Badge tone={RELAY_TONE[status] ?? "neutral"} title={th(`relayHelp.${status}`)}>
      {tk(`relayStatus.${status}`)}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const { tk, th } = useI18n();
  const tone: Tone = outcome === "EFFECTIVE" ? "ok" : outcome === "DUPLICATE" ? "neutral" : "bad";
  return (
    <Badge tone={tone} title={th(`controlHelp.${outcome}`)}>
      {tk(`controlOutcome.${outcome}`)}
    </Badge>
  );
}

export function GrantStateBadge({ state }: { state: string }) {
  const { tk } = useI18n();
  const tone: Tone = state === "CURRENT" ? "ok" : state === "EXPIRED" ? "warn" : "neutral";
  return <Badge tone={tone}>{tk(`grantState.${state}`)}</Badge>;
}

export function ActionBadge({ action }: { action: string }) {
  const { tk } = useI18n();
  const tone: Tone = action === "YES" ? "ok" : action === "NO" ? "bad" : "neutral";
  return <Badge tone={tone}>{tk(`choice.${action}`)}</Badge>;
}

export function CodeBadge({ code }: { code: string }) {
  const { th } = useI18n();
  return (
    <Badge tone="bad" title={th(`codeHelp.${code}`)}>
      {code}
    </Badge>
  );
}
