import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/lib/api";
import { anchorAbove, FlowError } from "../src/lib/flow";
import { compareTips, fetchIndependentTip, normalizeTipSource, sourceKind, sourceRequired, TipCheckError } from "../src/lib/tipcheck";
import { makeFixture, noSleep } from "./helpers/fixture";

const fast = { intervalMs: 0, sleep: noSleep, timeoutMs: 5_000 };

/** A fake independent source answering like a CKB node RPC or an Omavote /api/status. */
function source(kind: "rpc" | "omavote", genesis: string, tips: () => { number: bigint; hash: string }): FetchLike {
  return async (_url, init) => {
    if (kind === "omavote") {
      const tip = tips();
      return new Response(JSON.stringify({ network: { genesis_hash: genesis }, indexed: { number: tip.number.toString(), hash: tip.hash } }), { status: 200 });
    }
    const req = JSON.parse(String(init?.body));
    const result = req.method === "get_block_hash" ? genesis : (() => {
      const tip = tips();
      return { number: `0x${tip.number.toString(16)}`, hash: tip.hash };
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

describe("independent tip source", () => {
  it("accepts https and local http only", () => {
    expect(normalizeTipSource("")).toBe("");
    expect(normalizeTipSource("https://relay.example/api/status")).toBe("https://relay.example/api/status");
    expect(normalizeTipSource("http://127.0.0.1:8114")).toBe("http://127.0.0.1:8114/");
    expect(normalizeTipSource("http://relay.example/api/status")).toBeNull();
    expect(normalizeTipSource("https://user:pw@relay.example/")).toBeNull();
    expect(normalizeTipSource("not a url")).toBeNull();
    expect(sourceKind("https://relay.example/api/status")).toBe("omavote");
    expect(sourceKind("http://127.0.0.1:8114/")).toBe("rpc");
    expect(sourceRequired("mainnet")).toBe(true);
    expect(sourceRequired("devnet")).toBe(false);
  });

  it("reads both kinds of sources and refuses another network", async () => {
    const tip = () => ({ number: 42n, hash: "0x" + "ab".repeat(32) });
    for (const kind of ["rpc", "omavote"] as const) {
      const url = kind === "rpc" ? "http://127.0.0.1:8114/" : "https://relay.example/api/status";
      const t = await fetchIndependentTip(url, "0x" + "11".repeat(32), source(kind, "0x" + "11".repeat(32), tip));
      expect(t.height).toBe(42n);
      expect(t.kind).toBe(kind);
      await expect(fetchIndependentTip(url, "0x" + "11".repeat(32), source(kind, "0x" + "22".repeat(32), tip))).rejects.toBeInstanceOf(TipCheckError);
    }
    const a = { number: "42", hash: "0x" + "ab".repeat(32) };
    expect(compareTips(a, { height: 42n, hash: a.hash, kind: "rpc" })).toBe("match");
    expect(compareTips(a, { height: 42n, hash: "0x" + "cd".repeat(32), kind: "rpc" })).toBe("fork");
    expect(compareTips(a, { height: 43n, hash: a.hash, kind: "rpc" })).toBe("source_ahead");
    expect(compareTips(a, { height: 41n, hash: a.hash, kind: "rpc" })).toBe("source_behind");
  });

  it("waits while the server is one block behind, then signs on a matching tip", async () => {
    const f = makeFixture();
    const genesis = (await f.api.status()).network.genesis_hash;
    // The independent source is first one block ahead; the server then mines that block.
    let calls = 0;
    const ahead = { number: f.server.tip().number + 1n, hash: "0x" + "77".repeat(32) };
    const fetchImpl = source("rpc", genesis, () => {
      calls++;
      if (calls === 1) return ahead;
      const t = f.server.tip();
      return { number: t.number, hash: t.hash };
    });
    const waits: string[] = [];
    const first = f.server.tip();
    const anchor = await anchorAbove(f.api, null, {
      ...fast,
      tipSource: "http://127.0.0.1:8114/",
      fetchImpl,
      onTipWait: (cmp) => {
        waits.push(cmp);
        f.server.mine(1);
      },
    });
    expect(waits).toEqual(["source_ahead"]);
    expect(BigInt(anchor.number)).toBe(first.number + 1n);
  });

  it("refuses to sign while the two sources keep disagreeing", async () => {
    const f = makeFixture();
    const genesis = (await f.api.status()).network.genesis_hash;
    const fork = () => ({ number: f.server.tip().number, hash: "0x" + "99".repeat(32) });
    let t = 0;
    await expect(
      anchorAbove(f.api, null, {
        intervalMs: 1,
        timeoutMs: 10,
        sleep: async () => void (t += 5),
        now: () => t,
        tipSource: "http://127.0.0.1:8114/",
        fetchImpl: source("rpc", genesis, fork),
      }),
    ).rejects.toMatchObject({ key: "tip.mismatch" });
  });

  it("requires a source on mainnet and testnet, and skips it on development chains", async () => {
    const f = makeFixture();
    const status = f.api.status.bind(f.api);
    const named = (name: string) => async () => {
      const s = await status();
      return { ...s, network: { ...s.network, name } };
    };
    // Development chain without a source: no check.
    f.api.status = named("devnet");
    await expect(anchorAbove(f.api, null, { ...fast, tipSource: "" })).resolves.toBeTruthy();
    // Mainnet without a source: refuse.
    f.api.status = named("mainnet");
    const err = await anchorAbove(f.api, null, { ...fast, tipSource: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).key).toBe("tip.required");
  });
});
