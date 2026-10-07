/**
 * Carrier framing (docs/03 §7, docs/13 §5):
 *
 *   magic[8] = "OMAVOTE\0" | kind[u8] | version[u8] = 2 | scope_id[32] |
 *   payload_hash[32] | witness_index[u32 LE]          (78 bytes, cell data)
 *
 * The referenced witness holds the payload bytes, which must be the UTF-8 of
 * the JCS form of a JSON object, with
 *   payload_hash = H("OMAVOTE/PAYLOAD/V2\0" || kind || payload_bytes).
 */
import { bytesToHex, concatBytes, hexToBytes, isHash32 } from "./bytes.js";
import { SchemaError } from "./errors.js";
import { payloadHash } from "./hash.js";
import { isObject, jcs, parseStrictJsonBytes, utf8DecodeStrict, utf8Encode, type JsonValue } from "./json.js";

export const MAGIC = utf8Encode("OMAVOTE\0");
export const HEADER_LENGTH = 78;
export const CARRIER_VERSION = 2;

export const KIND = {
  MANIFEST: 1,
  BALLOT_BATCH: 2,
  RESULT_RECORD: 3,
  AUTHORIZATION_POLICY: 4,
  AUTHORIZATION_BATCH: 5,
  PROCESS_ROLES: 6,
  PROCESS_BATCH: 7,
} as const;

/**
 * Parse limits (docs/03 §7, fixed by docs/13 §4 item 21): the payload witness
 * (raw bytes; exceeding invalidates the carrier), a single envelope (JCS bytes;
 * exceeding rejects only that envelope) and the envelope count (more than 128,
 * or zero, invalidates the batch).
 */
export const LIMITS = {
  maxPayloadBytes: 32 * 1024,
  maxEnvelopeBytes: 8 * 1024,
  maxEnvelopes: 128,
} as const;

export interface CarrierHeader {
  kind: number;
  version: number;
  scopeId: string;
  payloadHash: string;
  witnessIndex: number;
}

/** "carrier" for 78-byte data with the magic; "malformed" for other data starting with the magic. */
export function classifyCellData(data: Uint8Array): "carrier" | "malformed" | "none" {
  if (data.length < MAGIC.length) return "none";
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) return "none";
  return data.length === HEADER_LENGTH ? "carrier" : "malformed";
}

export function decodeHeader(data: Uint8Array): CarrierHeader {
  if (classifyCellData(data) !== "carrier") throw new Error("not a 78-byte Omavote carrier header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    kind: data[8] as number,
    version: data[9] as number,
    scopeId: bytesToHex(data.subarray(10, 42)),
    payloadHash: bytesToHex(data.subarray(42, 74)),
    witnessIndex: view.getUint32(74, true),
  };
}

export function encodeHeader(h: CarrierHeader): Uint8Array {
  if (!isHash32(h.scopeId) || !isHash32(h.payloadHash)) throw new Error("scope_id and payload_hash must be 32-byte hashes");
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, h.witnessIndex, true);
  return concatBytes(MAGIC, new Uint8Array([h.kind, h.version]), hexToBytes(h.scopeId), hexToBytes(h.payloadHash), tail);
}

/** Builds header + payload for a JSON payload (used by tests and tooling). */
export function buildCarrier(kind: number, scopeId: string, payload: JsonValue, witnessIndex: number): { data: Uint8Array; witness: Uint8Array } {
  const witness = utf8Encode(jcs(payload));
  return { data: encodeHeader({ kind, version: CARRIER_VERSION, scopeId, payloadHash: payloadHash(kind, witness), witnessIndex }), witness };
}

/**
 * Validates the payload bytes against the header and returns the parsed JSON.
 * Throws SchemaError with a carrier-level diagnostic code.
 */
export function decodePayload(header: CarrierHeader, witness: Uint8Array): JsonValue {
  if (witness.length > LIMITS.maxPayloadBytes) throw new SchemaError(`payload of ${witness.length} bytes exceeds 32 KiB`, "PAYLOAD_TOO_LARGE");
  if (payloadHash(header.kind, witness) !== header.payloadHash) throw new SchemaError("payload_hash does not match the witness", "PAYLOAD_HASH_MISMATCH");
  let value: JsonValue;
  let text: string;
  try {
    text = utf8DecodeStrict(witness);
    value = parseStrictJsonBytes(witness);
  } catch (e) {
    throw new SchemaError(`payload is not strict JSON: ${(e as Error).message}`, "MALFORMED_PAYLOAD");
  }
  // docs/13 §4 item 13: every payload is canonical JCS; kind 3 (result record) may be any JSON value.
  if (header.kind !== KIND.RESULT_RECORD && !isObject(value)) throw new SchemaError("payload must be a JSON object", "MALFORMED_PAYLOAD");
  if (jcs(value) !== text) throw new SchemaError("payload bytes are not the JCS form of the value", "PAYLOAD_NOT_CANONICAL");
  return value;
}

/**
 * Batch framing `{"protocol_version":"2","envelopes":[...]}` shared by
 * ballot, authorization and process batches. Returns the raw envelopes.
 */
export function decodeBatch(value: JsonValue): JsonValue[] {
  if (!isObject(value)) throw new SchemaError("batch must be an object", "MALFORMED_PAYLOAD");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "envelopes,protocol_version") throw new SchemaError("batch must have exactly envelopes and protocol_version", "MALFORMED_PAYLOAD");
  if (value["protocol_version"] !== "2") throw new SchemaError("batch protocol_version must be \"2\"", "MALFORMED_PAYLOAD");
  const envelopes = value["envelopes"];
  if (!Array.isArray(envelopes)) throw new SchemaError("envelopes must be an array", "MALFORMED_PAYLOAD");
  if (envelopes.length > LIMITS.maxEnvelopes) throw new SchemaError(`batch has ${envelopes.length} envelopes (max 128)`, "BATCH_TOO_LARGE");
  if (envelopes.length === 0) throw new SchemaError("empty batch (docs/13 §4 item 21)", "EMPTY_BATCH");
  return envelopes;
}

/** Byte size of an envelope inside a canonical payload (its JCS serialization). */
export function envelopeSize(envelope: JsonValue): number {
  return utf8Encode(jcs(envelope)).length;
}
