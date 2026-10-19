// /notify の action_items に null などオブジェクトでない要素が混ざっても 500 にしない。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { jsonReq, mockFetch, dohPublic } from "./helpers.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/notify with non-object action items", () => {
  it("skips null and non-object items instead of returning 500", async () => {
    let sent;
    mockFetch(dohPublic(), (url, init) => {
      if (url !== WEBHOOK) return undefined;
      sent = JSON.parse(init.body).text;
      return new Response("ok", { status: 200 });
    });
    const valid = { id: 1, assignee: "佐藤", task: "資料作成", due_label: "金曜", priority: "high" };
    const res = await worker.fetch(
      jsonReq("/notify", {
        body: {
          minutes: "本文",
          action_items: [null, valid, "文字列", 42, [], undefined],
          title: "定例",
          slack: { enabled: true, webhook_url: WEBHOOK },
        },
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack_ok: true });
    // 件数は有効な要素だけを数える
    expect(sent).toContain("アクションアイテム（1件）");
    expect(sent).toContain("[high] 佐藤：資料作成（金曜）");
  });

  it("returns 400 when minutes is empty and no item is an object", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(
      jsonReq("/notify", {
        body: { minutes: "", action_items: [null, null], slack: { enabled: true, webhook_url: WEBHOOK } },
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("送信する議事録またはアクションアイテムがありません。");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
