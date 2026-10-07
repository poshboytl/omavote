import { describe, expect, it } from "vitest";
import { Api, ApiError, normalizeApiBase } from "../src/lib/api";
import { assertNoNumbers, Core, CoreError } from "../src/lib/core";
import { personalSign, preferredProvider, requestAccounts, walletError, WalletError } from "../src/lib/eip1193";
import { cleanHexInput, hexToBytes, parseCompressedPubkey, parseEvmAddress, parseHash32, parseSignature, utf8ToHex } from "../src/lib/hex";
import { buildSample } from "../src/lib/samples";
import { getPending, lastAnchor, listPending, rememberAnchor, removePending, savePending, type KV } from "../src/lib/storage";
import { MockEip1193, testSecret } from "./helpers/keys";
import { loadCoreForNode } from "./helpers/wasm";

describe("hex and signatures", () => {
  it("encodes the exact UTF-8 bytes of texts", () => {
    expect(utf8ToHex("abc")).toBe("0x616263");
    expect(utf8ToHex("中")).toBe("0xe4b8ad");
    expect(utf8ToHex("a\nb")).toBe("0x610a62");
    expect(utf8ToHex("😀")).toBe("0xf09f9880");
    // A text made only of hex digits is still sent as the hex of its characters.
    expect(utf8ToHex("deadbeef")).toBe("0x6465616462656566");
    expect(utf8ToHex("0x00")).toBe("0x30783030");
    expect([...hexToBytes("0x0aFF")]).toEqual([10, 255]);
    expect(() => hexToBytes("0x0")).toThrow();
  });

  it("normalises pasted signatures and checks length and recovery id", () => {
    const body = "11".repeat(64);
    expect(parseSignature(`0x${body}00`, "ckb")).toEqual({ ok: true, signature: `0x${body}00`, v: 0 });
    expect(parseSignature(`${body.toUpperCase()}01`, "ckb")).toMatchObject({ ok: true, signature: `0x${body}01` });
    expect(parseSignature(` 0X${body}\n01 `, "ckb")).toMatchObject({ ok: true });
    expect(parseSignature(`0x${body}1b`, "ckb")).toMatchObject({ ok: false, error: "recovery", v: 27 });
    expect(parseSignature(`0x${body}1b`, "evm")).toMatchObject({ ok: true, v: 27 });
    expect(parseSignature(`0x${body}02`, "evm")).toMatchObject({ ok: false, error: "recovery" });
    expect(parseSignature(`0x${body}`, "ckb")).toMatchObject({ ok: false, error: "length", bytes: 64 });
    expect(parseSignature("0xzz", "ckb")).toMatchObject({ ok: false, error: "not_hex" });
    expect(parseSignature("  ", "ckb")).toMatchObject({ ok: false, error: "empty" });
  });

  it("parses ids, addresses and keys", () => {
    expect(cleanHexInput(" AB cd ")).toBe("0xabcd");
    expect(parseHash32("0x" + "AA".repeat(32))).toBe("0x" + "aa".repeat(32));
    expect(parseHash32("0x1234")).toBeNull();
    expect(parseEvmAddress("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf")).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(parseEvmAddress("7e5f4552091a69125d5dfcb7b8c2659029395bdf")).toBeNull();
    expect(parseCompressedPubkey("0x02" + "11".repeat(32))).toBe("0x02" + "11".repeat(32));
    expect(parseCompressedPubkey("0x04" + "11".repeat(32))).toBeNull();
  });
});

describe("EIP-1193 wallet calls", () => {
  it("requests accounts and signs hex(utf8(text)) with personal_sign", async () => {
    const core = loadCoreForNode();
    const w = new MockEip1193(testSecret("eip1193"));
    expect(await requestAccounts(w)).toEqual([w.address]);
    for (const text of ["deadbeef", "OMAVOTE VOTE YES #0011223344556677 1000CKB\nline 2", "资助 🚀"]) {
      const sig = await personalSign(w, text, w.address);
      const call = w.calls[w.calls.length - 1];
      expect(call?.params).toEqual([utf8ToHex(text), w.address]);
      expect(sig).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
      expect(core.recoverEvm(text, sig).address).toBe(w.address);
      // The checksummed form is what wallets display.
      expect(core.recoverEvm(text, sig).checksum_address.toLowerCase()).toBe(w.address);
    }
    // Wallets returning v = 0/1 are accepted too.
    w.vZeroOne = true;
    const sig01 = await personalSign(w, "x", w.address);
    expect(sig01).toMatch(/0[01]$/);
    expect(core.recoverEvm("x", sig01).address).toBe(w.address);
  });

  it("maps wallet errors", async () => {
    const w = new MockEip1193(testSecret("reject"));
    w.rejectNext = true;
    await expect(personalSign(w, "x", w.address)).rejects.toMatchObject({ name: "WalletError", kind: "rejected", code: 4001 });
    expect(walletError({ code: -32002, message: "pending" }).kind).toBe("pending");
    expect(walletError({ code: 4100, message: "no" }).kind).toBe("unauthorized");
    expect(walletError(new Error("boom")).kind).toBe("other");
    const bad = { request: async () => "not a signature" };
    await expect(personalSign(bad, "x", w.address)).rejects.toBeInstanceOf(WalletError);
    const noAccounts = { request: async () => [] };
    await expect(requestAccounts(noAccounts)).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("prefers MetaMask among announced providers", () => {
    const p = (name: string, rdns: string) => ({ info: { uuid: name, name, icon: "", rdns }, provider: { request: async () => null } });
    expect(preferredProvider([p("Other", "com.other"), p("MetaMask", "io.metamask")])?.info.name).toBe("MetaMask");
    expect(preferredProvider([])).toBeNull();
  });
});

describe("API client", () => {
  it("normalises the configurable base URL", () => {
    expect(normalizeApiBase("")).toBe("");
    expect(normalizeApiBase(" https://vote.example.org/ ")).toBe("https://vote.example.org");
    expect(normalizeApiBase("https://mirror.example/omavote/api/")).toBe("https://mirror.example/omavote");
    expect(normalizeApiBase("http://127.0.0.1:18080")).toBe("http://127.0.0.1:18080");
    expect(normalizeApiBase("ftp://x")).toBeNull();
    expect(normalizeApiBase("javascript:alert(1)")).toBeNull();
    expect(normalizeApiBase("https://u:p@x.org")).toBeNull();
    expect(normalizeApiBase("https://x.org/?a=1")).toBeNull();
    expect(normalizeApiBase("not a url")).toBeNull();
  });

  it("builds URLs under the base and parses server errors", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const api = new Api("https://mirror.example", async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/api/receipts/" + "0x" + "aa".repeat(32))) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", detail: "receipt not found" } }), { status: 404 });
      }
      if (url.endsWith("/api/envelopes")) {
        return new Response(JSON.stringify({ error: { code: "OUT_OF_WINDOW", detail: "voting has ended" } }), { status: 422 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await api.ballots("0x" + "AB".repeat(32), "0x" + "cd".repeat(32));
    expect(seen[0]?.url).toBe(`https://mirror.example/api/proposals/0x${"ab".repeat(32)}/ballots?owner=0x${"cd".repeat(32)}`);
    expect(seen[0]?.init?.credentials).toBe("omit");
    await expect(api.receipts("0x" + "aa".repeat(32))).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(api.submit("{}")).rejects.toMatchObject({ status: 422, code: "OUT_OF_WINDOW", detail: "voting has ended" });
    expect(seen.at(-1)?.init?.method).toBe("POST");
    expect(() => api.proposal("0x12")).toThrow(ApiError);
    const down = new Api("", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(down.status()).rejects.toMatchObject({ code: "NETWORK" });
    const html = new Api("", async () => new Response("<html>", { status: 200 }));
    await expect(html.status()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("core facade", () => {
  it("refuses JSON numbers before calling the core and wraps core errors", () => {
    expect(() => assertNoNumbers({ a: ["1", { b: 2 }] })).toThrow(/params\.a\[1\]\.b/);
    const core = loadCoreForNode();
    expect(() => core.utc(5 as unknown as string)).toThrow(CoreError);
    expect(() => core.call("no_such_method", {})).toThrow(/unknown method/);
    const fake = new Core(() => {
      throw "boom";
    });
    expect(() => fake.nonce()).toThrow(CoreError);
    expect(core.nonce()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(core.nonce()).not.toBe(core.nonce());
  });
});

describe("device storage", () => {
  function memory(): KV {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }

  it("keeps signed envelopes for retry and forgets them on request", () => {
    const kv = memory();
    savePending({ id: "0x1", kind: "ballot", label: "a", envelope: { x: "1" }, created_ms: 1 }, kv);
    savePending({ id: "0x2", kind: "ballot", label: "b", envelope: { x: "2" }, created_ms: 2 }, kv);
    savePending({ id: "0x1", kind: "ballot", label: "a2", envelope: { x: "1" }, created_ms: 3 }, kv);
    expect(listPending(kv).map((p) => p.id)).toEqual(["0x1", "0x2"]);
    expect(getPending("0x1", kv)?.label).toBe("a2");
    removePending("0x1", kv);
    expect(listPending(kv).map((p) => p.id)).toEqual(["0x2"]);
  });

  it("remembers the last anchor per sequence and survives broken storage", () => {
    const kv = memory();
    expect(lastAnchor("s", kv)).toBeNull();
    rememberAnchor("s", { hash: "0xaa", number: "10" }, kv);
    expect(lastAnchor("s", kv)).toEqual({ hash: "0xaa", number: "10" });
    const broken: KV = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(listPending(broken)).toEqual([]);
    expect(() => savePending({ id: "x", kind: "ballot", label: "", envelope: null, created_ms: 0 }, broken)).not.toThrow();
  });
});

describe("wallet check samples", () => {
  it("are deterministic and well formed", () => {
    const core = loadCoreForNode();
    const a = buildSample(core, "ballot");
    const b = buildSample(core, "ballot");
    expect(a.text).toBe(b.text);
    expect(a.summary).toMatch(/^OMAVOTE VOTE YES #[0-9a-f]{16} 1000000CKB$/);
    expect(a.text).toContain("Title: 钱包验收样票 Wallet check sample");
    expect(a.network.name).toBe("testnet");
    const g = buildSample(core, "grant");
    expect(g.summary).toBe("OMAVOTE GRANT 0x11111111..11111111 TO 2028-01-01");
    expect(buildSample(core, "hexlike").text).toBe("0xdeadbeef");
    expect(buildSample(core, "hexlike").textHex).toBe("0x30786465616462656566");
  });
});
