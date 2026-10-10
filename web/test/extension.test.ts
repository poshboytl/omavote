import { describe, expect, it } from "vitest";
import { batches, EXTENSION_BATCH, ExtensionError, extensionError, findExtension, signBatch, type OmavoteSigner } from "../src/lib/extension";
import type { BallotBody, Manifest } from "../src/lib/types";

const SIG = `0x${"11".repeat(65)}`;
const manifest = {} as Manifest;
const body = (i: number) => ({ nonce: `n${i}` }) as unknown as BallotBody;

function fakeExtension(sign: OmavoteSigner["signBallots"]): OmavoteSigner {
  return {
    isOmavoteSigner: true,
    version: "1",
    getKey: async () => null,
    connect: async () => {
      throw new Error("not used");
    },
    signBallots: sign,
    disconnect: async () => null,
  };
}

describe("extension signer", () => {
  it("splits requests into batches of at most 20", () => {
    expect(batches(Array.from({ length: 45 }, (_, i) => i)).map((b) => b.length)).toEqual([20, 20, 5]);
    expect(EXTENSION_BATCH).toBe(20);
  });

  it("returns one signature per ballot, in order", async () => {
    const seen: number[] = [];
    const ext = fakeExtension(async (r) => {
      seen.push(r.bodies.length);
      return { signatures: r.bodies.map(() => SIG) };
    });
    expect(await signBatch(ext, manifest, [body(1), body(2)])).toEqual([SIG, SIG]);
    expect(seen).toEqual([2]);
  });

  it("refuses oversized batches before calling the extension", async () => {
    const ext = fakeExtension(async () => {
      throw new Error("must not be called");
    });
    await expect(signBatch(ext, manifest, Array.from({ length: 21 }, (_, i) => body(i)))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects malformed answers", async () => {
    const wrongCount = fakeExtension(async () => ({ signatures: [SIG] }));
    await expect(signBatch(wrongCount, manifest, [body(1), body(2)])).rejects.toBeInstanceOf(ExtensionError);
    const notHex = fakeExtension(async () => ({ signatures: ["0xzz"] }));
    await expect(signBatch(notHex, manifest, [body(1)])).rejects.toMatchObject({ code: "OTHER" });
  });

  it("maps the extension's error codes", async () => {
    const rejected = fakeExtension(async () => {
      throw Object.assign(new Error("no"), { code: "USER_REJECTED" });
    });
    await expect(signBatch(rejected, manifest, [body(1)])).rejects.toMatchObject({ code: "USER_REJECTED" });
    expect(extensionError({ code: "ANCHOR_REUSED", message: "m" }).code).toBe("ANCHOR_REUSED");
    expect(extensionError({ code: "SOMETHING", message: "m" }).code).toBe("OTHER");
  });

  it("only recognises the extension's own object", () => {
    const g = globalThis as { omavote?: unknown };
    g.omavote = { getKey: () => null };
    expect(findExtension()).toBeNull();
    g.omavote = fakeExtension(async () => ({ signatures: [] }));
    expect(findExtension()).not.toBeNull();
    delete g.omavote;
  });
});
