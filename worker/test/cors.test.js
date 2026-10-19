// M-1: ALLOWED_ORIGIN 未設定時に "*" へ落とさない。Vary: Origin を付ける。
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { jsonReq } from "./helpers.js";

const PROD = "https://tomu-ai963.github.io";

function get(path, origin) {
  return jsonReq(path, { method: "GET", headers: origin ? { origin } : {} });
}

function preflight(origin) {
  return new Request("https://worker.example/minutes", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-openai-key, x-anthropic-key",
    },
  });
}

describe("CORS with ALLOWED_ORIGIN set (production, unchanged)", () => {
  const env = { ALLOWED_ORIGIN: PROD };

  it("returns the configured origin for the production frontend", async () => {
    const res = await worker.fetch(get("/health", PROD), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("still returns the configured origin (not the caller's) for other origins", async () => {
    const res = await worker.fetch(get("/health", "https://evil.example"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
  });

  it("answers preflight with 204 and the allowed headers", async () => {
    const res = await worker.fetch(preflight(PROD), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("x-anthropic-key");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("keeps CORS headers on error responses (404)", async () => {
    const res = await worker.fetch(get("/nope", PROD), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
  });
});

describe("CORS with ALLOWED_ORIGIN unset", () => {
  const env = {};

  it("does not fall back to * for an arbitrary origin", async () => {
    const res = await worker.fetch(get("/health", "https://evil.example"), env);
    expect(res.status).toBe(200); // 本体の処理は通常どおり
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("does not send ACAO when the request has no Origin", async () => {
    const res = await worker.fetch(get("/health"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not answer preflight with ACAO for an arbitrary origin", async () => {
    const res = await worker.fetch(preflight("https://evil.example"), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:5500", "http://localhost"])(
    "reflects local dev origin %s",
    async (o) => {
      const res = await worker.fetch(preflight(o), env);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(o);
      expect(res.headers.get("Vary")).toBe("Origin");
    }
  );

  it.each(["https://localhost:8787", "http://localhost.evil.example", "http://127.0.0.1.evil.example:80"])(
    "rejects look-alike origin %s",
    async (o) => {
      const res = await worker.fetch(get("/health", o), env);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  );
});
