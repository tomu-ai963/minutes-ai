// L-2: Notion のタイトルプロパティ名を GET /v1/databases/:id で事前取得してからページを作成する。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { jsonReq, mockFetch, jsonResponse } from "./helpers.js";

const DB_ID = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.restoreAllMocks();
});

function notify(extra = {}) {
  return worker.fetch(
    jsonReq("/notify", {
      body: {
        minutes: "# 会議議事録\n本文",
        action_items: [{ id: 1, assignee: "田中", task: "共有", due_label: "7月5日まで", priority: "high" }],
        title: "定例会議",
        notion: { enabled: true, token: "secret_test", database_id: DB_ID, ...extra },
      },
    }),
    {}
  );
}

function schema(properties) {
  return jsonResponse({ object: "database", id: DB_ID, properties });
}

describe("/notify Notion title property lookup (L-2)", () => {
  it("uses the title property name from the database schema", async () => {
    const calls = [];
    mockFetch((url, init) => {
      if (!url.startsWith("https://api.notion.com/")) return undefined;
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      if (url === `https://api.notion.com/v1/databases/${DB_ID}`) {
        return schema({
          ステータス: { id: "a", type: "select", select: {} },
          件名: { id: "title", type: "title", title: {} },
        });
      }
      if (url === "https://api.notion.com/v1/pages") return jsonResponse({ url: "https://www.notion.so/page-1" });
      return undefined;
    });

    const res = await notify();
    const data = await res.json();
    expect(data).toEqual({ notion_ok: true, notion_page_url: "https://www.notion.so/page-1" });

    // GET → POST の 2 回だけ。総当たりはしない
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.notion.com/v1/databases/${DB_ID}`,
      "POST https://api.notion.com/v1/pages",
    ]);
    expect(calls[0].headers["Notion-Version"]).toBe("2022-06-28");
    expect(calls[0].headers.Authorization).toBe("Bearer secret_test");
    const post = calls[1].body;
    expect(Object.keys(post.properties)).toEqual(["件名"]);
    expect(post.properties["件名"].title[0].text.content).toBe("定例会議");
    expect(post.parent).toEqual({ database_id: DB_ID });
  });

  it("reports a missing / unshared database (404) without creating a page", async () => {
    const spy = mockFetch((url) =>
      url.startsWith("https://api.notion.com/v1/databases/")
        ? jsonResponse({ object: "error", status: 404, code: "object_not_found", message: "Could not find database" }, 404)
        : undefined
    );
    const data = await (await notify()).json();
    expect(data.notion_ok).toBe(false);
    expect(data.notion_error).toBe(
      "Notion のデータベースが見つかりません。データベース ID と、インテグレーションへの共有設定をご確認ください。"
    );
    expect(spy.mock.calls.some((c) => String(c[0]).endsWith("/v1/pages"))).toBe(false);
  });

  it("reports an invalid token (401) on the schema lookup", async () => {
    mockFetch((url) =>
      url.startsWith("https://api.notion.com/v1/databases/")
        ? jsonResponse({ object: "error", status: 401, code: "unauthorized", message: "API token is invalid." }, 401)
        : undefined
    );
    const data = await (await notify()).json();
    expect(data).toEqual({
      notion_ok: false,
      notion_error: "Notion のトークンが無効です。インテグレーション設定をご確認ください。",
    });
  });

  it("reports when the database has no title property", async () => {
    mockFetch((url) =>
      url.startsWith("https://api.notion.com/v1/databases/") ? schema({ メモ: { id: "x", type: "rich_text" } }) : undefined
    );
    const data = await (await notify()).json();
    expect(data).toEqual({ notion_ok: false, notion_error: "Notion のデータベースにタイトルプロパティが見つかりませんでした。" });
  });

  it("reports a page creation failure with its status", async () => {
    mockFetch((url) => {
      if (url.startsWith("https://api.notion.com/v1/databases/")) return schema({ Name: { id: "title", type: "title" } });
      if (url === "https://api.notion.com/v1/pages") {
        return jsonResponse({ object: "error", status: 400, code: "validation_error", message: "body failed validation" }, 400);
      }
      return undefined;
    });
    const data = await (await notify()).json();
    expect(data.notion_ok).toBe(false);
    expect(data.notion_error).toMatch(/^Notion への保存に失敗しました（400）: /);
    expect(data.notion_error).toContain("body failed validation");
  });

  it("URL-encodes the database id in the lookup path", async () => {
    const spy = mockFetch((url) =>
      url.startsWith("https://api.notion.com/") ? jsonResponse({ object: "error", status: 400 }, 400) : undefined
    );
    await notify({ database_id: "../users/me" });
    expect(String(spy.mock.calls[0][0])).toBe("https://api.notion.com/v1/databases/..%2Fusers%2Fme");
  });
});
