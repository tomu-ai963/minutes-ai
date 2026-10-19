// M-5: 500 応答に内部エラー詳細（err.message）を含めない。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { jsonReq, formReq, audioFile, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unhandled error → 500 (M-5)", () => {
  it("returns only a Japanese message, without detail / err.message", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // JSON の null は body.minutes で TypeError になり、ハンドラー外の catch に落ちる
    const res = await worker.fetch(jsonReq("/notify", { body: null }), {});

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toEqual({ error: "サーバー内部でエラーが発生しました。" });
    expect(JSON.stringify(data)).not.toContain("TypeError");

    // 本当に catch 経路を通ったこと（例外がログに残っていること）を確認する
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain("TypeError");
    expect(String(logSpy.mock.calls[0][0])).toContain("POST /notify");
  });

  it("does not leak API keys into the log", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const openaiKey = "sk-openai-SECRET-1234567890";
    const anthropicKey = "anthropic-SECRET-abcdef";
    // Whisper の成功応答の本文読み取りで、キーを含むメッセージの例外を投げさせる
    mockFetch((url) => {
      if (url.startsWith("https://api.openai.com/")) {
        return /** @type {any} */ ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error(`boom ${openaiKey} / ${anthropicKey} / sk-otherkey12345678`);
          },
        });
      }
      return undefined;
    });

    const res = await worker.fetch(
      formReq("/minutes", {
        headers: { "x-openai-key": openaiKey, "x-anthropic-key": anthropicKey },
        file: audioFile(),
      }),
      {}
    );

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("boom");
    expect(body).not.toContain("SECRET");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0][0]);
    expect(logged).toContain("boom"); // 例外自体はログに残る
    expect(logged).not.toContain(openaiKey);
    expect(logged).not.toContain(anthropicKey);
    expect(logged).not.toContain("sk-otherkey12345678");
    expect(logged).toContain("[REDACTED]");
  });
});
