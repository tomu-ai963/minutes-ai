// M-3: /minutes の議事録生成とアクションアイテム抽出を並列実行する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { formReq, audioFile, mockFetch, jsonResponse, anthropicText, anthropicKind } from "./helpers.js";

const KEYS = { "x-openai-key": "sk-test-openai", "x-anthropic-key": "test-anthropic" };
const MINUTES_MD = "# 会議議事録\n日時：x\n\n---\n*この議事録はAIにより自動生成されました*";
const ITEMS_JSON = JSON.stringify([
  { id: 1, assignee: "田中さん", task: "資料共有", due: "2026-07-05", due_label: "7月5日まで", priority: "high" },
]);

const whisperOk = (url) =>
  url.startsWith("https://api.openai.com/") ? jsonResponse({ text: "文字起こし本文" }) : undefined;

function minutesReq() {
  return formReq("/minutes", { headers: KEYS, file: audioFile() });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/minutes parallel Claude calls (M-3)", () => {
  it("starts action-item extraction before minutes generation finishes", async () => {
    const events = [];
    let releaseMinutes;
    const minutesGate = new Promise((r) => (releaseMinutes = r));

    mockFetch(whisperOk, async (url, init) => {
      if (!url.startsWith("https://api.anthropic.com/")) return undefined;
      const kind = anthropicKind(init);
      events.push(`start:${kind}`);
      if (kind === "minutes") {
        // 抽出側の開始を待つ（直列実行ならここで待ち続けるのでタイムアウトで解放する）
        await Promise.race([minutesGate, new Promise((r) => setTimeout(r, 300))]);
        events.push("end:minutes");
        return anthropicText(MINUTES_MD);
      }
      releaseMinutes();
      return anthropicText(ITEMS_JSON);
    });

    const res = await worker.fetch(minutesReq(), {});
    expect(res.status).toBe(200);
    // 抽出の開始が議事録生成の完了より前であること
    expect(events.indexOf("start:actions")).toBeGreaterThan(-1);
    expect(events.indexOf("start:actions")).toBeLessThan(events.indexOf("end:minutes"));

    const data = await res.json();
    expect(data.transcript).toBe("文字起こし本文");
    expect(data.minutes).toBe(MINUTES_MD);
    expect(data.action_items).toHaveLength(1);
    expect(data.action_items[0].task).toBe("資料共有");
  });

  it("returns the minutes error when minutes generation fails, even if extraction succeeds", async () => {
    mockFetch(whisperOk, (url, init) => {
      if (!url.startsWith("https://api.anthropic.com/")) return undefined;
      return anthropicKind(init) === "minutes"
        ? jsonResponse({ error: { type: "rate_limit_error", message: "slow down" } }, 429)
        : anthropicText(ITEMS_JSON);
    });
    const res = await worker.fetch(minutesReq(), {});
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Anthropic APIのレート制限です。時間をおいて再度お試しください。");
  });

  it("returns minutes with empty action_items when extraction fails", async () => {
    mockFetch(whisperOk, (url, init) => {
      if (!url.startsWith("https://api.anthropic.com/")) return undefined;
      return anthropicKind(init) === "minutes"
        ? anthropicText(MINUTES_MD)
        : jsonResponse({ error: { type: "api_error", message: "overloaded" } }, 529);
    });
    const res = await worker.fetch(minutesReq(), {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.minutes).toBe(MINUTES_MD);
    expect(data.action_items).toEqual([]);
  });

  it("returns minutes with empty action_items when extraction output is not JSON", async () => {
    mockFetch(whisperOk, (url, init) => {
      if (!url.startsWith("https://api.anthropic.com/")) return undefined;
      return anthropicKind(init) === "minutes" ? anthropicText(MINUTES_MD) : anthropicText("該当なし");
    });
    const res = await worker.fetch(minutesReq(), {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_items).toEqual([]);
    expect(data).not.toHaveProperty("raw");
  });

  it("does not call Claude when Whisper fails", async () => {
    const spy = mockFetch((url) =>
      url.startsWith("https://api.openai.com/") ? jsonResponse({ error: { message: "bad key" } }, 401) : undefined
    );
    const res = await worker.fetch(minutesReq(), {});
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("OpenAI APIキーが無効です。キーを確認してください。");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("anthropic"))).toBe(false);
  });
});
