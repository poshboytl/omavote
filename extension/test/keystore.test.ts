import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, PBKDF2_ITERATIONS } from "../src/keystore";
import { SignerError } from "../src/protocol";
import { publicKeyOf, secretFor } from "./helpers";

const PASSWORD = "correct horse battery staple";
// Fewer iterations keep the tests fast; the record carries its own count.
const FAST = 1000;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SignerError ? e.code : String(e);
  }
}

describe("keystore", () => {
  const secret = secretFor("keystore");
  const pk = publicKeyOf(secret);

  it("round-trips with the default parameters", async () => {
    const ks = await encryptSecret(secret, pk, PASSWORD);
    expect(ks.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS });
    expect(ks.kdf.salt).toMatch(/^0x[0-9a-f]{32}$/);
    expect(ks.cipher.iv).toMatch(/^0x[0-9a-f]{24}$/);
    expect(JSON.stringify(ks)).not.toContain(secret.slice(2));
    expect(await decryptSecret(ks, PASSWORD, publicKeyOf)).toBe(secret);
  });

  it("uses a fresh salt and IV every time", async () => {
    const a = await encryptSecret(secret, pk, PASSWORD, FAST);
    const b = await encryptSecret(secret, pk, PASSWORD, FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects a wrong password", async () => {
    const ks = await encryptSecret(secret, pk, PASSWORD, FAST);
    expect(await code(decryptSecret(ks, "wrong password!!", publicKeyOf))).toBe("WRONG_PASSWORD");
  });

  it("rejects a tampered ciphertext", async () => {
    const ks = await encryptSecret(secret, pk, PASSWORD, FAST);
    const flipped = ks.ciphertext.slice(0, -1) + (ks.ciphertext.endsWith("0") ? "1" : "0");
    expect(await code(decryptSecret({ ...ks, ciphertext: flipped }, PASSWORD, publicKeyOf))).toBe("WRONG_PASSWORD");
  });

  it("binds the ciphertext to its public key through the AAD", async () => {
    const ks = await encryptSecret(secret, pk, PASSWORD, FAST);
    const other = publicKeyOf(secretFor("someone else"));
    expect(await code(decryptSecret({ ...ks, public_key: other }, PASSWORD, publicKeyOf))).toBe("WRONG_PASSWORD");
  });

  it("refuses unknown versions and short passwords", async () => {
    const ks = await encryptSecret(secret, pk, PASSWORD, FAST);
    expect(await code(decryptSecret({ ...ks, version: 2 }, PASSWORD, publicKeyOf))).toBe("INVALID_REQUEST");
    expect(await code(encryptSecret(secret, pk, "short", FAST))).toBe("INVALID_REQUEST");
    // Twelve characters, counted as Unicode characters rather than UTF-16 units.
    expect(await code(encryptSecret(secret, pk, "投票口令投票口令投票口令", FAST))).toBe("ok");
  });
});
