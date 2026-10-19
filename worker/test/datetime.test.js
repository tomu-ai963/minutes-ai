// L-4: 生成日時を Asia/Tokyo で整形する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { formatJstDisplay, formatJstIso } from "../src/lib/datetime.js";
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

  it("formats ISO time with +09:00 offset that round-trips to the same instant", () => {
    const iso = formatJstIso(NOW);
    expect(iso).toBe("2026-10-20T05:30:15+09:00");
    expect(new Date(iso).getTime()).toBe(NOW.getTime());
  });

  it("handles year boundaries", () => {
    expect(formatJstIso(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01T00:00:00+09:00");
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

  it("/save stores and returns created_at in JST", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const bound = [];
    const env = {
      DB: {
        prepare: () => ({
          bind: (...args) => {
            bound.push(args);
            return { run: async () => ({}) };
          },
        }),
      },
    };
    const res = await worker.fetch(jsonReq("/save", { body: { minutes: "# 会議議事録", title: "定例" } }), env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.created_at).toBe("2026-10-20T05:30:15+09:00");
    expect(bound[0][3]).toBe("2026-10-20T05:30:15+09:00");
  });
});
