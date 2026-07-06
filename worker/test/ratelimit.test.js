import { describe, it, expect, beforeEach } from "vitest";
import { slidingWindow, enforceRateLimit, _resetMemoryStore } from "../src/lib/ratelimit.js";

describe("slidingWindow", () => {
  it("allows up to the limit within the window", () => {
    let ts = [];
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = slidingWindow(ts, 3, 60_000, now + i);
      expect(r.allowed).toBe(true);
      ts = r.timestamps;
    }
    const blocked = slidingWindow(ts, 3, 60_000, now + 4);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("evicts timestamps older than the window", () => {
    const now = 1_000_000;
    const ts = [now - 120_000, now - 90_000]; // どちらも 60s より前 → 期限切れ
    const r = slidingWindow(ts, 2, 60_000, now);
    expect(r.allowed).toBe(true);
    expect(r.timestamps).toEqual([now]); // 古いものは除去され、新規1件のみ
  });
});

describe("enforceRateLimit (memory fallback)", () => {
  beforeEach(() => _resetMemoryStore());

  it("blocks after exceeding the per-key limit", async () => {
    const env = {}; // RATE_LIMITER 未バインド → メモリ版
    const buckets = [{ key: "rl:test:a", limit: 2, windowMs: 60_000 }];
    const now = 5_000_000;
    expect((await enforceRateLimit(env, buckets, now)).allowed).toBe(true);
    expect((await enforceRateLimit(env, buckets, now + 1)).allowed).toBe(true);
    const third = await enforceRateLimit(env, buckets, now + 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it("keeps separate counters per key (tenant vs ip)", async () => {
    const env = {};
    const now = 5_000_000;
    const a = [{ key: "rl:x:tenantA", limit: 1, windowMs: 60_000 }];
    const b = [{ key: "rl:x:tenantB", limit: 1, windowMs: 60_000 }];
    expect((await enforceRateLimit(env, a, now)).allowed).toBe(true);
    expect((await enforceRateLimit(env, a, now + 1)).allowed).toBe(false);
    // 別キーは独立してカウントされる
    expect((await enforceRateLimit(env, b, now + 1)).allowed).toBe(true);
  });

  it("blocks if ANY bucket is over the limit", async () => {
    const env = {};
    const now = 5_000_000;
    // tenant バケットは緩いが ip バケットが厳しい
    const buckets = [
      { key: "rl:x:tenant", limit: 100, windowMs: 60_000 },
      { key: "rl:x:ip", limit: 1, windowMs: 60_000 },
    ];
    expect((await enforceRateLimit(env, buckets, now)).allowed).toBe(true);
    expect((await enforceRateLimit(env, buckets, now + 1)).allowed).toBe(false);
  });

  it("uses Durable Object stub when bound", async () => {
    // DO バインドをモックし、DO 経路が使われることを確認する。
    const store = new Map();
    const doStub = {
      fetch: async (_url, init) => {
        const { limit, windowMs, now } = JSON.parse(init.body);
        const r = slidingWindow(store.get("ts") || [], limit, windowMs, now);
        store.set("ts", r.timestamps);
        return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
      },
    };
    const env = {
      RATE_LIMITER: {
        idFromName: (name) => ({ name }),
        get: () => doStub,
      },
    };
    const buckets = [{ key: "rl:do:a", limit: 1, windowMs: 60_000 }];
    const now = 7_000_000;
    expect((await enforceRateLimit(env, buckets, now)).allowed).toBe(true);
    expect((await enforceRateLimit(env, buckets, now + 1)).allowed).toBe(false);
    expect(store.get("ts").length).toBe(1);
  });
});
