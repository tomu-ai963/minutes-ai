// M-4: parseActionItems の結果をスキーマ { id, assignee, task, due, due_label, priority } に正規化する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { parseActionItems, normalizeActionItems, extractJsonArray } from "../src/lib/action-items.js";
import { jsonReq, mockFetch, anthropicText } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM = { id: 1, assignee: "田中さん", task: "資料共有", due: "2026-07-05", due_label: "7月5日まで", priority: "high" };

describe("extractJsonArray", () => {
  it("parses a pure JSON array", () => {
    expect(extractJsonArray(JSON.stringify([ITEM]))).toEqual([ITEM]);
  });

  it("parses inside a code fence", () => {
    expect(extractJsonArray("```json\n" + JSON.stringify([ITEM]) + "\n```")).toEqual([ITEM]);
  });

  it("is not fooled by a bracketed preamble like [注意]", () => {
    const text = `[注意] 以下が結果です:\n${JSON.stringify([ITEM])}\n以上です。`;
    expect(extractJsonArray(text)).toEqual([ITEM]);
  });

  it("prefers the object array over a numeric preamble array like [1]", () => {
    const text = `[1] 抽出結果: ${JSON.stringify([ITEM])}`;
    expect(extractJsonArray(text)).toEqual([ITEM]);
  });

  it("is not fooled by trailing brackets after the array", () => {
    const text = `${JSON.stringify([ITEM])}\n[補足] 期限は推定です。`;
    expect(extractJsonArray(text)).toEqual([ITEM]);
  });

  it("handles ] and [ inside string values", () => {
    const item = { ...ITEM, task: "配列 [a] と ] を含む \"文字列\"" };
    expect(extractJsonArray(`結果: ${JSON.stringify([item])}`)).toEqual([item]);
  });

  it("returns null when no JSON array exists", () => {
    expect(extractJsonArray("アクションアイテムはありません")).toBeNull();
    expect(extractJsonArray("[未定] のみ")).toBeNull();
  });
});

describe("normalizeActionItems", () => {
  it("keeps a valid item as-is", () => {
    expect(normalizeActionItems([ITEM])).toEqual([ITEM]);
  });

  it("drops non-object elements and elements without task, and renumbers ids", () => {
    const out = normalizeActionItems([
      null,
      "文字列",
      42,
      ["配列"],
      { assignee: "佐藤", task: "   " },
      { assignee: "佐藤", due: "2026-01-01" },
      { id: 99, assignee: "鈴木", task: "見積もり送付", priority: "low" },
      { id: 7, task: "日程調整" },
    ]);
    expect(out.map((x) => x.task)).toEqual(["見積もり送付", "日程調整"]);
    expect(out.map((x) => x.id)).toEqual([1, 2]);
  });

  it("fills defaults for missing fields", () => {
    expect(normalizeActionItems([{ task: "共有" }])).toEqual([
      { id: 1, assignee: "未定", task: "共有", due: null, due_label: "期限未定", priority: "medium" },
    ]);
  });

  it("validates due as a real YYYY-MM-DD date, otherwise null", () => {
    const due = (v) => normalizeActionItems([{ task: "t", due: v }])[0].due;
    expect(due("2026-07-05")).toBe("2026-07-05");
    expect(due("2026-07-05T10:00:00+09:00")).toBe("2026-07-05");
    expect(due("2026-02-30")).toBeNull();
    expect(due("2026-13-01")).toBeNull();
    expect(due("7月5日")).toBeNull();
    expect(due("2026-7-5")).toBeNull();
    expect(due(20260705)).toBeNull();
    expect(due(null)).toBeNull();
  });

  it("uses due as due_label when the label is missing", () => {
    expect(normalizeActionItems([{ task: "t", due: "2026-07-05" }])[0].due_label).toBe("2026-07-05");
  });

  it("normalizes priority to high / medium / low", () => {
    const p = (v) => normalizeActionItems([{ task: "t", priority: v }])[0].priority;
    expect(p("HIGH")).toBe("high");
    expect(p(" low ")).toBe("low");
    expect(p("高")).toBe("high");
    expect(p("低")).toBe("low");
    expect(p("urgent")).toBe("medium");
    expect(p(1)).toBe("medium");
    expect(p(undefined)).toBe("medium");
  });

  it("coerces non-string assignee/task values safely", () => {
    const out = normalizeActionItems([{ task: { evil: true } }, { task: 123, assignee: { x: 1 } }]);
    expect(out).toEqual([{ id: 1, assignee: "未定", task: "123", due: null, due_label: "期限未定", priority: "medium" }]);
  });
});

describe("parseActionItems", () => {
  it("returns [] for empty text and null when no array is found", () => {
    expect(parseActionItems("")).toEqual([]);
    expect(parseActionItems("該当なし")).toBeNull();
  });
});

describe("/extract applies the schema (M-4)", () => {
  function extract(claudeOutput) {
    mockFetch((url) => (url.startsWith("https://api.anthropic.com/") ? anthropicText(claudeOutput) : undefined));
    return worker.fetch(
      jsonReq("/extract", { headers: { "x-anthropic-key": "test-anthropic" }, body: { transcript: "会議" } }),
      {}
    );
  }

  it("extracts the array even after a bracketed preamble", async () => {
    const res = await extract(`[重要] 抽出しました:\n${JSON.stringify([ITEM])}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_items: [ITEM] });
  });

  it("drops invalid elements and normalizes fields", async () => {
    const res = await extract(
      JSON.stringify([
        { id: 5, assignee: "田中", task: "共有", due: "明日", priority: "HIGH", extra: "x" },
        { assignee: "佐藤" },
        "garbage",
      ])
    );
    expect(await res.json()).toEqual({
      action_items: [{ id: 1, assignee: "田中", task: "共有", due: null, due_label: "期限未定", priority: "high" }],
    });
  });

  it("still returns raw with an empty list when no array is found", async () => {
    const res = await extract("申し訳ありませんが抽出できませんでした");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_items: [], raw: "申し訳ありませんが抽出できませんでした" });
  });
});
