// Protocol objects (docs/03, docs/11, docs/13 §4) and server API views
// (crates/omavote/src/api.rs, views.rs). Integers are always decimal strings.

export type Hex = string;
export type Dec = string;

export interface Script {
  code_hash: Hex;
  hash_type: string;
  args: Hex;
}

export interface ScriptId {
  code_hash: Hex;
  hash_type: string;
}

export interface NetworkParams {
  name: string;
  genesis_hash: Hex;
  hrp: string;
  secp256k1: ScriptId;
  dao: ScriptId;
  omnilock: ScriptId | null;
  pw_lock: ScriptId | null;
}

export type Action = "YES" | "NO" | "CANCEL";
export type Authority = "owner" | "delegate";
export type RevokeMode = "STOP_ONLY" | "STOP_AND_CANCEL_OPEN";
export type ControlAction = "GRANT" | "REVOKE";
export type Role = "committee" | "coordinator";
export type RecordType =
  | "ADMISSION"
  | "NOTICE"
  | "GOVERNANCE_STATUS"
  | "RESULT_ATTESTATION"
  | "EXECUTION"
  | "ROLES_UPDATE";

export interface Ratio {
  numerator: Dec;
  denominator: Dec;
}

export interface RulesProfile {
  profile: string;
  asset: string;
  amount: string;
  weight_time: string;
  withdraw_phase1: string;
  cast_eligibility: string;
  revote: string;
  authorization: string;
  cancel: string;
  precision: string;
  choices: string[];
  quorum_grant_multiplier: Dec;
  quorum_meta_rule_shannon: Dec;
  approval_grant: Ratio;
  approval_meta_rule: Ratio;
  threshold_comparison: "inclusive" | "strict";
  opening_confirmations: Dec;
  delegate_cutoff_ms: Dec;
  voting_period_ms: Dec;
  proposer_min_deposit_shannon: Dec;
}

export interface AuthPolicy {
  message_kind: "authorization_policy";
  protocol_version: string;
  network_genesis_hash: Hex;
  dao_namespace: string;
  clock: string;
  max_term_ms: Dec;
  max_control_publication_delay_ms: Dec;
  semantics: string;
}

export interface AuthRegistry {
  owner_adapters: string[];
  key_adapters: string[];
}

export interface Manifest {
  message_kind: "manifest";
  protocol_version: string;
  network_genesis_hash: Hex;
  dao_namespace: string;
  nonce: Hex;
  proposal_type: "grant" | "meta_rule";
  title: string;
  signing_title: string;
  content_hash: Hex;
  content_locations: string[];
  forum_topic_id: Dec;
  forum_revision: Dec;
  discussion_evidence_hash: Hex | null;
  budget_ckb_shannon: Dec;
  quorum_base_shannon: Dec;
  payment_terms_hash: Hex | null;
  recipient_lock_script: Script | null;
  proposer_owner_locks: Script[];
  rules_profile: RulesProfile;
  rules_hash: Hex;
  auth_registry: AuthRegistry;
  auth_registry_hash: Hex;
  authorization_policy: AuthPolicy;
  auth_policy_hash: Hex;
  signature_formats: string[];
  clock: string;
  start_ms: Dec;
  end_ms: Dec;
  confirmation_policy: { result_confirmations: Dec; review_window_ms: Dec };
  publication_policy: string;
}

export interface Proof {
  signature: Hex;
}

export interface ProposerProof {
  owner_lock: Script;
  auth_adapter: string;
  proof: Proof;
}

export interface ManifestPayload {
  protocol_version: string;
  manifest: Manifest;
  proposer_proofs: ProposerProof[];
}

export interface BallotBody {
  message_kind: "ballot";
  protocol_version: string;
  action: Action;
  authority: Authority;
  authorization_id: Hex | null;
  signer_key_id: Hex | null;
  nonce: Hex;
  anchor_block_hash: Hex;
  auth_adapter: string;
  dao_namespace: string;
  network_genesis_hash: Hex;
  owner_lock: Script;
  poll_id: Hex;
  rules_hash: Hex;
  signature_format: string;
}

export type KeyDescriptor =
  | { kind: "secp256k1"; public_key: Hex; adapter: string }
  | { kind: "evm_eoa"; address: Hex; adapter: string };

export interface ControlBody {
  protocol_version: string;
  message_kind: "authorization_control";
  network_genesis_hash: Hex;
  dao_namespace: string;
  auth_policy_hash: Hex;
  owner_lock: Script;
  owner_auth_adapter: string;
  action: ControlAction;
  key_descriptor: KeyDescriptor | null;
  expires_at_ms: Dec | null;
  revoke_mode: RevokeMode | null;
  anchor_block_hash: Hex;
  publication_deadline_ms: Dec;
  nonce: Hex;
  signature_format: string;
}

export type RecordDetail =
  | { decision: "ADMITTED" | "REJECTED" }
  | { code: string }
  | { status: "HOLD_EXECUTION" | "CLEARED" | "VOIDED" }
  | { result_hash: Hex; outcome: "PASS" | "FAIL" }
  | { tx_hash: Hex }
  | { new_roles_hash: Hex };

export interface ProcessRecordBody {
  message_kind: "process_record";
  protocol_version: string;
  network_genesis_hash: Hex;
  dao_namespace: string;
  roles_hash: Hex;
  role: Role;
  record_type: RecordType;
  poll_id: Hex | null;
  detail: RecordDetail;
  evidence_hash: Hex | null;
  anchor_block_hash: Hex;
  publication_deadline_ms: Dec;
  nonce: Hex;
}

export interface BallotEnvelope {
  body: BallotBody;
  proof: Proof;
}

export interface ControlEnvelope {
  body: ControlBody;
  proof: Proof;
}

export interface ProcessEnvelope {
  body: ProcessRecordBody;
  proofs: { signer_key_id: Hex; proof: Proof }[];
}

export interface RoleMembers {
  threshold: Dec;
  members: KeyDescriptor[];
}

export interface ProcessRoles {
  message_kind: "process_roles";
  protocol_version: string;
  network_genesis_hash: Hex;
  dao_namespace: string;
  previous_roles_hash: Hex | null;
  roles: { committee: RoleMembers; coordinator: RoleMembers };
  nonce: Hex;
}

// ---------------------------------------------------------------------------
// API views

export interface At {
  number: Dec;
  hash: Hex;
  clock_ms: Dec;
}

export interface Position {
  height: Dec;
  tx_index: Dec;
  output_index: Dec;
  envelope_index: Dec;
}

export interface ApiErrorBody {
  error: { code: string; detail: string };
}

/** `GET /api/forum/import`: the current revision of a Nervos Talk topic (untrusted). */
export interface ForumImport {
  source: string;
  topic_id: string;
  title: string;
  revision: string;
  post_id: string;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  content_raw: string;
  content_hash: Hex;
  recipient_candidates: string[];
  historical_likes_verified: boolean;
}

export interface StatusView {
  version: string;
  network: { name: string; genesis_hash: Hex };
  indexed: At | null;
  node_tip: Dec | null;
  synced: boolean;
  last_sync_ms: Dec;
  last_error: string | null;
  reorgs: {
    count: Dec;
    last: { at_ms: Dec; old_tip: Dec; fork_height: Dec; depth: Dec } | null;
  };
  polls: Dec;
  diagnostics: Dec;
  lag_blocks: Dec | null;
  /** True until governance approves the deployment: no governance effect. */
  shadow_mode?: boolean;
  relay: {
    intake: boolean;
    receipt_key: Hex | null;
  shadow_mode?: boolean;
    queue: Record<string, Dec>;
    address?: string | null;
    balance_shannon?: Dec | null;
  };
}

export interface NetworkInfo {
  at: At | null;
  network: NetworkParams;
  genesis_cells?: unknown;
  authorization_policy: { object: AuthPolicy; hash: Hex; published: Position | null };
  default_registry: { object: AuthRegistry; hash: Hex };
  default_rules: { object: RulesProfile; hash: Hex };
  initial_roles_hash: Hex | null;
  current_roles: { roles_hash: Hex; object: ProcessRoles } | null;
  process_publication_delay_ms: Dec;
  max_control_publication_delay_ms: Dec;
  receipt_key: Hex | null;
}

export interface AnchorInfo {
  number: Dec;
  hash: Hex;
  clock_ms: Dec;
  control_publication_deadline_ms: Dec;
  process_publication_deadline_ms: Dec;
}

export interface AnchorView {
  anchor: AnchorInfo;
  at: At | null;
}

export type AdmissionState =
  | { state: "PENDING" }
  | { state: "ADMITTED"; record_id: Hex }
  | { state: "REJECTED"; record_id: Hex }
  | { state: "MISSING" }
  | { state: "RECORD_CONFLICT" };

export type GovernanceState =
  | { state: "NONE" }
  | { state: "HOLD_EXECUTION" | "CLEARED" | "VOIDED"; record_id: Hex }
  | { state: "RECORD_CONFLICT"; effective: string };

export type AttestationState =
  | { state: "NONE" }
  | { state: "CONFIRMED"; record_id: Hex }
  | { state: "DISPUTED"; detail: string }
  | { state: "RECORD_CONFLICT" };

interface TallyCounts {
  yes_shannon: Dec;
  no_shannon: Dec;
  participation_shannon: Dec;
  quorum_required_shannon: Dec;
  owners: Dec;
}

/** Closed poll: computed from the close snapshot, with an outcome and result_hash. */
export interface FinalTally extends TallyCounts {
  kind: "FINAL";
  outcome: "PASS" | "FAIL";
  result_hash: Hex;
}

/**
 * Open poll: the current count with today's deposits. It is not a result and
 * carries no outcome; the page must never derive pass/fail from these numbers.
 */
export interface ProvisionalTally extends TallyCounts {
  kind: "PROVISIONAL";
  note?: string;
}

export type TallyView = FinalTally | ProvisionalTally;

export type PollStatus =
  | "ANNOUNCED"
  | "OPEN"
  | "CLOSED_UNCONFIRMED"
  | "AUDITABLE"
  | "FINALIZED_BY_POLICY"
  | "EXECUTED"
  | "DISPUTED"
  | "LATE_MANIFEST";

export interface ProposalSummary {
  poll_id: Hex;
  short_id: string;
  title: string;
  signing_title: string;
  proposal_type: "grant" | "meta_rule";
  budget_ckb_shannon: Dec;
  start_ms: Dec;
  end_ms: Dec;
  delegate_end_ms: Dec;
  status: PollStatus | string;
  registered: { position: Position; tx_hash: Hex };
  late_manifest: boolean;
  proposer_deposit_shannon: Dec;
  proposer_eligible: boolean;
  admission: AdmissionState;
  governance: GovernanceState;
  attestation: AttestationState;
  ballot_count: Dec;
  tally: TallyView | null;
}

export interface RecordView {
  record_id: Hex;
  record_type: RecordType;
  poll_id: Hex | null;
  detail: Record<string, string>;
  anchor_height: Dec;
  position: Position;
  tx_hash: Hex;
  signers: Hex[];
  envelope: ProcessEnvelope;
}

export interface ResultOwnerRow {
  owner_id: Hex;
  final_status: string;
  ballot_id: Hex | null;
  authorization_id: Hex | null;
  eligible_principal_shannon: Dec;
  counted_weight_shannon: Dec;
}

export interface ResultCore {
  protocol_version: string;
  network_genesis_hash: Hex;
  poll_id: Hex;
  rules_hash: Hex;
  auth_policy_hash: Hex;
  auth_registry_hash: Hex;
  start_boundary_block_hash: Hex;
  close_block_hash: Hex;
  close_block_number: Dec;
  owners: ResultOwnerRow[];
  counted_cells: { tx_hash: Hex; index: Dec; owner_id: Hex; capacity_shannon: Dec }[];
  yes_shannon: Dec;
  no_shannon: Dec;
  participation_shannon: Dec;
  quorum_required_shannon: Dec;
  approval_numerator: Dec;
  approval_denominator: Dec;
  threshold_comparison: string;
  outcome: "PASS" | "FAIL";
}

export interface ProposalDetail extends ProposalSummary {
  at: At | null;
  manifest_payload: ManifestPayload;
  hashes: {
    poll_id: Hex;
    rules_hash: Hex;
    auth_policy_hash: Hex;
    auth_registry_hash: Hex;
    content_hash: Hex;
  };
  start_boundary: { number: Dec; hash: Hex } | null;
  close: { number: Dec; hash: Hex } | null;
  result_core: ResultCore | null;
  result_hash: Hex | null;
  records: RecordView[];
}

export interface ProposalsView {
  at: At | null;
  proposals: ProposalSummary[];
}

export type BallotStatus =
  | "SELECTED"
  | "SUPERSEDED"
  | "CONFLICT"
  | "CANCELLED_BY_CONTROL"
  | "OVERRIDDEN_BY_OWNER"
  | "UNKNOWN";

export interface BallotView {
  ballot_id: Hex;
  owner_id: Hex;
  authority: Authority;
  authorization_id: Hex | null;
  action: Action;
  anchor_height: Dec;
  grant_anchor_height: Dec;
  position: Position;
  tx_hash: Hex;
  status: BallotStatus | string;
  envelope: BallotEnvelope;
}

export interface Diagnostic {
  position: Position;
  tx_hash: Hex;
  kind: string;
  id: Hex | null;
  poll_id: Hex | null;
  owner_id: Hex | null;
  code: string;
  detail: string;
  /** The rejected signed object when it could be decoded (evidence), else null. */
  object?: unknown;
}

export interface BallotsView {
  at: At | null;
  poll_id: Hex;
  order: string;
  ballots: BallotView[];
  rejected: Diagnostic[];
}

export interface RecordsView {
  at: At | null;
  poll_id: Hex;
  records: RecordView[];
  rejected: Diagnostic[];
  admission: AdmissionState;
  governance: GovernanceState;
  attestation: AttestationState;
}

export interface DepositView {
  tx_hash: Hex;
  index: Dec;
  capacity_shannon: Dec;
  created?: Position | null;
  created_height?: Dec;
}

export interface OwnerPower {
  at: At | null;
  owner_id: Hex;
  owner_lock: Script | null;
  address: string | null;
  total_shannon: Dec;
  deposits: DepositView[];
}

export interface AddressView extends OwnerPower {
  lock_kind: "secp256k1_blake160" | "omnilock" | "pw_lock" | "other" | string;
}

export interface GrantView {
  authorization_id: Hex;
  policy_hash: Hex;
  owner_id: Hex;
  owner_adapter: string;
  key_descriptor: KeyDescriptor;
  key_id: Hex;
  expires_at_ms: Dec;
  position: Position;
  anchor_height: Dec;
  cancels_open: boolean;
  state: "CURRENT" | "EXPIRED" | "CONFLICT_OR_REPLACED" | "NOT_CURRENT" | string;
}

export interface ControlEvent {
  authorization_id: Hex;
  action: ControlAction;
  anchor_height: Dec;
  position: Position;
  tx_hash: Hex;
  outcome: "EFFECTIVE" | "STALE_AUTHORIZATION" | "DUPLICATE" | "AUTH_CONFLICT" | string;
  envelope: ControlEnvelope;
}

export interface StreamView {
  at?: At | null;
  policy_hash: Hex;
  owner_id: Hex;
  owner_lock?: Script | null;
  max_anchor_height?: Dec | null;
  conflict?: boolean;
  current: GrantView | null;
  barriers?: { position: Position; clock_ms: Dec }[];
  history: ControlEvent[];
}

export interface KeyAuthorizationsView {
  at: At | null;
  key_id: Hex;
  grants: GrantView[];
}

export interface OwnerBallotsView {
  at: At | null;
  owner_id: Hex;
  polls: { poll_id: Hex; title: string; ballots: BallotView[] }[];
}

export interface RelayReceipt {
  body: {
    message_kind: "relay_receipt";
    protocol_version: string;
    network_genesis_hash: Hex;
    relay_receipt_key: Hex;
    item_kind: string;
    object_id: Hex;
    envelope_hash: Hex;
    received_at_ms: Dec;
    publish_by_ms: Dec | null;
  };
  signature: Hex;
}

export type RelayStatus = "RECEIVED" | "BROADCAST" | "INCLUDED" | "CONFIRMED" | "EXPIRED" | "FAILED";

export interface RelayItem {
  status: RelayStatus | "ALREADY_ON_CHAIN" | string;
  duplicate?: boolean;
  message_kind: string;
  object_id: Hex;
  /** Poll id for ballots, policy hash for controls (poll id / new roles hash for records). */
  scope_id?: Hex | null;
  /** Owner of a ballot or control, otherwise null. */
  owner_id?: Hex | null;
  received_ms?: Dec;
  envelope_hash?: Hex;
  tx_hash?: Hex | null;
  block_number?: Dec | null;
  block_hash?: Hex | null;
  error?: string | null;
  receipt?: RelayReceipt | null;
}

export interface ReceiptsView {
  items: RelayItem[];
}

/** Ballots and controls of an owner accepted by this relay and not yet CONFIRMED. */
export interface QueuedView {
  owner_id: Hex;
  queued: (RelayItem & { envelope: { body?: { anchor_block_hash?: Hex; message_kind?: string } } | null })[];
}

export interface DiagnosticsView {
  at: At | null;
  order: string;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Core (WASM) outputs

export interface ManifestInfo {
  poll_id: Hex;
  short_id: string;
  rules_hash: Hex;
  auth_policy_hash: Hex;
  auth_registry_hash: Hex;
  proposal_type: string;
  budget_ckb: string;
  quorum_required_shannon: Dec;
  start_ms: Dec;
  end_ms: Dec;
  delegate_end_ms: Dec;
  start_utc: string;
  end_utc: string;
  recipient_address?: string;
}

export interface KeyInfo {
  descriptor: KeyDescriptor;
  key_id: Hex;
  adapter: string;
  key_display?: string;
  key_short?: string;
}

export interface LockInfo {
  script: Script;
  address: string;
  owner_id: Hex;
}

export interface VerifyResult {
  ok: boolean;
  error: string | null;
}
