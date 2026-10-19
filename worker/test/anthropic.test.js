// L-3: callClaude / callClaudeActionItems を callAnthropicMessages に共通化した後も、
// リクエストの形とエンドポイントごとのエラー文言が変わらないことを固定する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { jsonReq, mockFetch, jsonResponse, anthropicText } from "./helpers.js";

const KEY = "test-anthropic-key";

afterEach(() => {
  vi.restoreAllMocks();
});

function generate(body = { transcript: "会議の文字起こし" }) {
  return worker.fetch(jsonReq("/generate", { headers: { "x-anthropic-key": KEY }, body }), {});
}
function extract(body = { transcript: "会議の文字起こし" }) {
  return worker.fetch(jsonReq("/extract", { headers: { "x-anthropic-key": KEY }, body }), {});
}

function anthropicRoute(handler) {
  return (url, init) => (url === "https://api.anthropic.com/v1/messages" ? handler(init) : undefined);
}

describe("Anthropic request shape (L-3)", () => {
  it.each([
    ["/generate", generate, "議事録作成アシスタント"],
    ["/extract", extract, "アクションアイテムを抽出"],
  ])("%s sends the same headers and default model", async (_name, call, promptMarker) => {
    let captured;
    mockFetch(
      anthropicRoute((init) => {
        captured = init;
        return anthropicText("[]");
      })
    );
    await call();
    expect(captured.method).toBe("POST");
    expect(captured.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(captured.body);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain(promptMarker);
    expect(body.messages[0].content).toContain("会議の文字起こし");
  });

  it("passes the model override through", async () => {
    let model;
    mockFetch(anthropicRoute((init) => ((model = JSON.parse(init.body).model), anthropicText("# 会議議事録"))));
    await generate({ transcript: "x", model: "claude-opus-5-5" });
    expect(model).toBe("claude-opus-5-5");
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    mockFetch(
      anthropicRoute(() =>
        jsonResponse({
          content: [
            { type: "text", text: "# 会議議事録" },
            { type: "thinking", thinking: "内部" },
            { type: "text", text: "本文" },
          ],
        })
      )
    );
    expect(await (await generate()).json()).toEqual({ minutes: "# 会議議事録\n本文" });
  });
});

describe("Anthropic error mapping per endpoint (L-3)", () => {
  const cases = [
    {
      name: "network failure",
      route: () => {
        throw new TypeError("network down");
      },
      generate: [502, "議事録生成APIへの接続に失敗しました。時間をおいて再度お試しください。"],
      extract: [502, "アクションアイテム抽出APIへの接続に失敗しました。時間をおいて再度お試しください。"],
    },
    {
      name: "401",
      route: () => jsonResponse({ error: { type: "authentication_error", message: "invalid x-api-key" } }, 401),
      generate: [401, "Anthropic APIキーが無効です。キーを確認してください。"],
      extract: [401, "Anthropic APIキーが無効です。キーを確認してください。"],
    },
    {
      name: "429",
      route: () => jsonResponse({ error: { type: "rate_limit_error", message: "slow" } }, 429),
      generate: [429, "Anthropic APIのレート制限です。時間をおいて再度お試しください。"],
      extract: [429, "Anthropic APIのレート制限です。時間をおいて再度お試しください。"],
    },
    {
      name: "500",
      route: () => jsonResponse({ error: { type: "api_error", message: "internal" } }, 500),
      generate: [502, "議事録の生成に失敗しました（500）: internal"],
      extract: [502, "アクションアイテムの抽出に失敗しました（500）: internal"],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: /generate`, async () => {
      mockFetch(anthropicRoute(c.route));
      const res = await generate();
      expect(res.status).toBe(c.generate[0]);
      expect(await res.json()).toEqual({ error: c.generate[1] });
    });
    it(`${c.name}: /extract`, async () => {
      mockFetch(anthropicRoute(c.route));
      const res = await extract();
      expect(res.status).toBe(c.extract[0]);
      expect(await res.json()).toEqual({ error: c.extract[1] });
    });
  }

  it("empty minutes output → 502 on /generate, but an empty list on /extract", async () => {
    mockFetch(anthropicRoute(() => jsonResponse({ content: [] })));
    const g = await generate();
    expect(g.status).toBe(502);
    expect(await g.json()).toEqual({ error: "議事録の生成結果が空でした。もう一度お試しください。" });
    const e = await extract();
    expect(e.status).toBe(200);
    expect(await e.json()).toEqual({ action_items: [] });
  });
});
