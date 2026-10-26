// L-4: 生成日時を Asia/Tokyo で整形する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { formatJstDisplay } from "../src/lib/datetime.js";
import { jsonReq, mockFetch, anthropicText } from "./helpers.js";

// UTC では 10/19 20:30、JST では翌日 10/20 05:30（日付が変わる時刻を選ぶ）
const NOW = new Date("2026-10-19T20:30:15Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("datetime formatting", () => {
  it("formats display time in JST", () => {
    expect(formatJstDisplay(NOW)).toBe("2026-10-20 05:30 (JST)");
  });

  it("handles year boundaries", () => {
    expect(formatJstDisplay(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01 00:00 (JST)");
  });
});

describe("timestamps in responses (L-4)", () => {
  it("the minutes prompt uses JST generation time", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    let prompt;
    mockFetch((url, init) => {
      if (url !== "https://api.anthropic.com/v1/messages") return undefined;
      prompt = JSON.parse(init.body).messages[0].content;
      return anthropicText("# 会議議事録");
    });
    const res = await worker.fetch(
      jsonReq("/generate", { headers: { "x-anthropic-key": "k" }, body: { transcript: "x" } }),
      {}
    );
    expect(res.status).toBe(200);
    expect(prompt).toContain('日時：[生成日時 — "2026-10-20 05:30 (JST)" を使用]');
    expect(prompt).not.toContain("2026-10-19T20:30");
  });

});
