// Password-encrypted keystore (docs/19 §7): PBKDF2-HMAC-SHA256 derives an AES-256-GCM
// key; the AAD binds the ciphertext to the record version and the public key.

import { bytesToHex, hexToBytes } from "../../web/src/lib/hex";
import { SignerError } from "./protocol";

export const KEYSTORE_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;

export interface Keystore {
  version: number;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ciphertext: string;
  public_key: string;
}

const enc = new TextEncoder();

/** Bytes backed by a plain ArrayBuffer, as WebCrypto's types require. */
function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(hex));
}

function aad(version: number, publicKey: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`omavote-signer/keystore/v${version}\n${publicKey}`);
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function checkPassword(password: string): void {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    throw new SignerError("INVALID_REQUEST", `the password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

/** Encrypt a 32-byte secret (hex) under a password, with a fresh salt and IV. */
export async function encryptSecret(secretHex: string, publicKey: string, password: string, iterations = PBKDF2_ITERATIONS): Promise<Keystore> {
  checkPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(KEYSTORE_VERSION, publicKey) }, key, bytes(secretHex));
  return {
    version: KEYSTORE_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: bytesToHex(salt) },
    cipher: { name: "AES-GCM", iv: bytesToHex(iv) },
    ciphertext: bytesToHex(new Uint8Array(ct)),
    public_key: publicKey,
  };
}

/**
 * Decrypt the secret. `derivePublicKey` recomputes the public key from the secret,
 * which must equal the stored one. Any failure reads as a wrong password.
 */
export async function decryptSecret(ks: Keystore, password: string, derivePublicKey: (secretHex: string) => string): Promise<string> {
  if (ks.version !== KEYSTORE_VERSION || ks.kdf.name !== "PBKDF2" || ks.kdf.hash !== "SHA-256" || ks.cipher.name !== "AES-GCM") {
    throw new SignerError("INVALID_REQUEST", `unsupported keystore version ${String(ks.version)}`);
  }
  let secret: string;
  try {
    const key = await deriveKey(password, bytes(ks.kdf.salt), ks.kdf.iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(ks.cipher.iv), additionalData: aad(ks.version, ks.public_key) },
      key,
      bytes(ks.ciphertext),
    );
    secret = bytesToHex(new Uint8Array(pt));
  } catch {
    throw new SignerError("WRONG_PASSWORD", "wrong password");
  }
  if (derivePublicKey(secret) !== ks.public_key) throw new SignerError("WRONG_PASSWORD", "the keystore does not match its public key");
  return secret;
}
