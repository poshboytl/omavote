// EIP-1193 wallet access (MetaMask and compatible). The page never sees private keys:
// it asks the wallet to sign the exact UTF-8 bytes of a displayed text.

import { parseSignature, utf8ToHex } from "./hex";

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

export interface ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface DiscoveredProvider {
  info: ProviderInfo;
  provider: Eip1193Provider;
}

export class WalletError extends Error {
  readonly code: number | null;
  readonly kind: "rejected" | "pending" | "unauthorized" | "no_wallet" | "bad_response" | "other";
  constructor(kind: WalletError["kind"], message: string, code: number | null = null) {
    super(message);
    this.name = "WalletError";
    this.kind = kind;
    this.code = code;
  }
}

/** Map an EIP-1193 error object to a WalletError. */
export function walletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const o = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof o.code === "number" ? o.code : null;
  const message = typeof o.message === "string" ? o.message : String(e);
  if (code === 4001) return new WalletError("rejected", message, code);
  if (code === -32002) return new WalletError("pending", message, code);
  if (code === 4100) return new WalletError("unauthorized", message, code);
  return new WalletError("other", message, code);
}

/**
 * EIP-6963 discovery of injected wallets. Falls back to `window.ethereum`.
 * Resolves after `waitMs` with every provider that announced itself.
 */
export function discoverProviders(waitMs = 300): Promise<DiscoveredProvider[]> {
  const w = globalThis as unknown as {
    addEventListener?: (t: string, l: (e: Event) => void) => void;
    removeEventListener?: (t: string, l: (e: Event) => void) => void;
    dispatchEvent?: (e: Event) => boolean;
    ethereum?: Eip1193Provider;
  };
  return new Promise((resolve) => {
    const found: DiscoveredProvider[] = [];
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<DiscoveredProvider>).detail;
      if (d?.info?.uuid && d.provider && !found.some((f) => f.info.uuid === d.info.uuid)) found.push(d);
    };
    if (!w.addEventListener || !w.dispatchEvent || typeof Event !== "function") {
      resolve(w.ethereum ? [{ info: legacyInfo(w.ethereum), provider: w.ethereum }] : []);
      return;
    }
    w.addEventListener("eip6963:announceProvider", onAnnounce);
    w.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      w.removeEventListener?.("eip6963:announceProvider", onAnnounce);
      if (found.length === 0 && w.ethereum) found.push({ info: legacyInfo(w.ethereum), provider: w.ethereum });
      resolve(found);
    }, waitMs);
  });
}

function legacyInfo(p: Eip1193Provider): ProviderInfo {
  return { uuid: "window.ethereum", name: p.isMetaMask ? "MetaMask" : "Injected wallet", icon: "", rdns: "" };
}

/** Prefer MetaMask when several wallets are injected. */
export function preferredProvider(list: DiscoveredProvider[]): DiscoveredProvider | null {
  return list.find((p) => p.info.rdns === "io.metamask") ?? list.find((p) => p.provider.isMetaMask) ?? list[0] ?? null;
}

export async function requestAccounts(p: Eip1193Provider): Promise<string[]> {
  let res: unknown;
  try {
    res = await p.request({ method: "eth_requestAccounts" });
  } catch (e) {
    throw walletError(e);
  }
  if (!Array.isArray(res) || !res.every((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))) {
    throw new WalletError("bad_response", "eth_requestAccounts returned an unexpected value");
  }
  if (res.length === 0) throw new WalletError("unauthorized", "no account was shared by the wallet");
  return res as string[];
}

/**
 * EIP-191 `personal_sign` over the exact UTF-8 bytes of `text`.
 * Params are `["0x" + hex(utf8(text)), address]`; returns lowercase `0x` + 65 bytes.
 */
export async function personalSign(p: Eip1193Provider, text: string, address: string): Promise<string> {
  let res: unknown;
  try {
    res = await p.request({ method: "personal_sign", params: [utf8ToHex(text), address] });
  } catch (e) {
    throw walletError(e);
  }
  if (typeof res !== "string") throw new WalletError("bad_response", "personal_sign returned a non-string value");
  const parsed = parseSignature(res, "evm");
  if (!parsed.ok) throw new WalletError("bad_response", `personal_sign returned an unexpected signature (${parsed.error})`);
  return parsed.signature;
}
