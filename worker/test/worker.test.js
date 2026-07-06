import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";

const ORIGIN = "https://tomu-ai963.github.io";

function req(path, { method = "POST", ip = "203.0.113.9", headers = {}, body } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/health", () => {
  it("returns ok and is not rate limited", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(req("/health", { method: "GET", ip: "9.9.9.9" }), {});
      expect(res.status).toBe(200);
    }
  });
});

describe("/notify SSRF guard (H-1)", () => {
  it("rejects a private-IP webhook_url without making the outbound call", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(
      req("/notify", {
        ip: "203.0.113.10",
        body: {
          minutes: "テスト議事録",
          slack: { enabled: true, webhook_url: "http://169.254.169.254/latest/meta-data/" },
        },
      }),
      {}
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.slack_ok).toBe(false);
    expect(data.slack_error).toContain("許可されていない");
    // メタデータエンドポイントへの実 fetch は発生しない
    const calledMeta = spy.mock.calls.some((c) => String(c[0]).includes("169.254.169.254"));
    expect(calledMeta).toBe(false);
  });

  it("rejects an obfuscated-IP webhook_url (2130706433 = 127.0.0.1)", async () => {
    const res = await worker.fetch(
      req("/notify", {
        ip: "203.0.113.11",
        body: {
          minutes: "x",
          slack: { enabled: true, webhook_url: "http://2130706433/hook" },
        },
      }),
      {}
    );
    const data = await res.json();
    expect(data.slack_ok).toBe(false);
    expect(data.slack_error).toContain("Webhook");
  });
});

describe("rate limiting (H-2)", () => {
  it("returns 429 with Retry-After after exceeding the IP limit", async () => {
    // /transcribe の IP 上限は 20/min。21 回目で 429 を期待する。
    const ip = "198.51.100.7";
    let last;
    for (let i = 0; i < 21; i++) {
      last = await worker.fetch(req("/transcribe", { ip }), {});
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("Retry-After")).toBeTruthy();
    const data = await last.json();
    expect(data.error).toContain("リクエストが多すぎます");
  });

  it("keeps CORS headers on the 429 response", async () => {
    const ip = "198.51.100.8";
    const env = { ALLOWED_ORIGIN: ORIGIN };
    let last;
    for (let i = 0; i < 21; i++) {
      last = await worker.fetch(req("/transcribe", { ip }), env);
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});
