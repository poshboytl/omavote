// Validate the cross-language vectors (and optional extra files) against the schema.
// Usage: npm install && npm test [-- extra.json ...]
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const root = new URL("../", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("schemas/omavote-v2.schema.json", root)));
const ajv = new Ajv2020({ strict: true, allErrors: true, strictRequired: false, allowUnionTypes: true });
ajv.addSchema(schema);
const check = (def, value, label) => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!v(value)) {
    console.error(`FAIL ${label} (${def})`, JSON.stringify(v.errors, null, 1));
    process.exitCode = 1;
  } else {
    count++;
  }
};
let count = 0;
const vectors = (f) => JSON.parse(readFileSync(new URL(`vectors/${f}`, root)));
const kinds = {
  auth_policy: "authorization_policy",
  process_roles: "process_roles",
  manifest: "manifest",
  key_descriptor: "key_descriptor",
  grant: "control_envelope",
  grant_cancel: "control_envelope",
  revoke: "control_envelope",
  direct_ballot: "ballot_envelope",
  delegate_ballot: "ballot_envelope",
  proposal: "manifest_payload",
  admission: "process_envelope",
  result_attestation: "process_envelope",
};
for (const item of vectors("messages.json").items) {
  const def = kinds[item.name];
  if (!def) throw new Error(`no schema mapping for vector item ${item.name}`);
  check(def, item.json ?? item.envelope, `messages.json:${item.name}`);
}
const replay = vectors("replay.json");
check("result_core", replay.expected.result_core, "replay.json:result_core");
for (const extra of process.argv.slice(2)) {
  const b = JSON.parse(readFileSync(extra));
  if (b.result_core) check("result_core", b.result_core, `${extra}:result_core`);
  for (const bal of b.ballots ?? []) check("ballot_envelope", bal.envelope, `${extra}:ballot ${bal.ballot_id}`);
  for (const c of b.controls ?? []) for (const h of c.history ?? []) check("control_envelope", h.envelope, `${extra}:control ${h.authorization_id}`);
  if (b.poll?.manifest_payload) check("manifest_payload", b.poll.manifest_payload, `${extra}:manifest_payload`);
  for (const r of b.poll?.records ?? []) check("process_envelope", r.envelope, `${extra}:record ${r.record_id}`);
}
console.log(`${count} objects valid`);
