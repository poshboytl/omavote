/**
 * Diagnostic records. The public shape `{height, kind, id, code}` follows
 * vectors/replay.json. `kind` is the message_kind of the object concerned
 * ("ballot", "authorization_control", "process_record", "manifest",
 * "authorization_policy", "process_roles"), "carrier" for framing failures
 * (id = transaction hash) or "owner" for tally notes (id = owner_id).
 *
 * Codes (docs/03 §11 recommends an open-ended list ("等", "etc."); extra codes are ours, see SPEC-NOTES):
 *   carrier:   CARRIER_MALFORMED UNSUPPORTED_VERSION UNKNOWN_KIND WITNESS_MISSING
 *              PAYLOAD_TOO_LARGE PAYLOAD_HASH_MISMATCH MALFORMED_PAYLOAD PAYLOAD_NOT_CANONICAL
 *              BATCH_TOO_LARGE EMPTY_BATCH
 *   any object: MALFORMED WRONG_NETWORK SCOPE_MISMATCH ENVELOPE_TOO_LARGE DUPLICATE
 *              INVALID_SIGNATURE WRONG_OWNER ANCHOR_INVALID ADAPTER_NOT_ACCEPTED
 *   manifest:  HASH_MISMATCH UNSUPPORTED_RULES UNKNOWN_ADAPTER POLICY_UNKNOWN LATE_MANIFEST
 *   ballot:    UNKNOWN_POLL LATE_MANIFEST RULES_MISMATCH FORMAT_NOT_ACCEPTED UNSUPPORTED_FORMAT
 *              UNSUPPORTED_ADAPTER WRONG_KEY OUT_OF_WINDOW NO_DEPOSIT_AT_CAST NO_ACTIVE_GRANT GRANT_EXPIRED
 *   control:   POLICY_UNKNOWN DEADLINE_MISMATCH PUBLICATION_EXPIRED EXPIRY_INVALID GRANT_EXPIRED
 *              STALE_AUTHORIZATION AUTH_CONFLICT
 *   record:    ROLES_NOT_EFFECTIVE ROLES_UNAVAILABLE ROLES_CHAIN_MISMATCH INSUFFICIENT_SIGNATURES
 *              DEADLINE_MISMATCH PUBLICATION_EXPIRED RECORD_CONFLICT
 *   owner:     ZERO_FINAL_WEIGHT
 */

export interface Position {
  height: number;
  tx: number;
  output: number;
  envelope: number;
}

export function comparePositions(a: Position, b: Position): number {
  return a.height - b.height || a.tx - b.tx || a.output - b.output || a.envelope - b.envelope;
}

export interface Diagnostic {
  height: string;
  kind: string;
  id: string | null;
  code: string;
  /** Poll the diagnostic belongs to, if any (used to filter per-poll output; not serialized). */
  pollId?: string;
  /** Human-readable explanation (only serialized with --verbose). */
  message?: string;
  position?: Position;
}

export function publicDiagnostic(d: Diagnostic, verbose: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { height: d.height, kind: d.kind, id: d.id, code: d.code };
  if (verbose) {
    if (d.position) out["position"] = { tx_index: String(d.position.tx), output_index: String(d.position.output), envelope_index: String(d.position.envelope) };
    if (d.message) out["message"] = d.message;
  }
  return out;
}
