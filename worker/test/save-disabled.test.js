// M-2: /save・GET /minutes/:id は保存機能を提供しない（D1 の有無に関わらず 410）。
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index.js";
import { jsonReq } from "./helpers.js";

const PROD = "https://tomu-ai963.github.io";
const MESSAGE = "議事録の保存機能は提供していません。議事録を残す場合は Notion 連携（/notify）をご利用ください。";

// prepare が呼ばれたら記録する D1 モック
function fakeDb() {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({ run: async () => ({}), first: async () => ({ id: "x" }) }),
    })),
  };
}

const cases = [
  ["POST /save", () => jsonReq("/save", { body: { minutes: "# 会議議事録", title: "定例" } })],
  ["GET /minutes/:id", () => jsonReq("/minutes/0b6f3c1e-1234-4abc-9def-0123456789ab", { method: "GET" })],
];

describe.each(cases)("%s is not provided (M-2)", (_name, makeReq) => {
  it("returns 410 with the Japanese message without a DB binding", async () => {
    const res = await worker.fetch(makeReq(), {});
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: MESSAGE });
  });

  it("returns 410 and never touches the DB even when one is bound", async () => {
    const DB = fakeDb();
    const res = await worker.fetch(makeReq(), { DB });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: MESSAGE });
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  it("keeps CORS headers on the 410 response", async () => {
    const req = makeReq();
    req.headers.set("origin", PROD);
    const res = await worker.fetch(req, { ALLOWED_ORIGIN: PROD, DB: fakeDb() });
    expect(res.status).toBe(410);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD);
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});

describe("/save does not read the request body (M-2)", () => {
  it("leaves the body unread", async () => {
    const req = jsonReq("/save", { body: { minutes: "# 会議議事録" } });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(410);
    expect(req.bodyUsed).toBe(false);
  });
});
