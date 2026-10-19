// L-5: Slack 通知本文のメンション（<!channel> 等）をエスケープし、件数上限を設ける。
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { jsonReq, mockFetch, dohPublic } from "./helpers.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

afterEach(() => {
  vi.restoreAllMocks();
});

// /notify を Slack のみ有効で呼び、Webhook に送られた text を返す
async function sentText(title, actionItems) {
  let sent;
  mockFetch(dohPublic(), (url, init) => {
    if (url !== WEBHOOK) return undefined;
    sent = JSON.parse(init.body).text;
    return new Response("ok", { status: 200 });
  });
  const res = await worker.fetch(
    jsonReq("/notify", {
      body: { minutes: "本文", action_items: actionItems, title, slack: { enabled: true, webhook_url: WEBHOOK } },
    }),
    {}
  );
  expect(await res.json()).toEqual({ slack_ok: true });
  expect(typeof sent).toBe("string");
  return sent;
}

const item = (n, extra = {}) => ({ id: n, assignee: `担当${n}`, task: `タスク${n}`, due_label: "期限未定", priority: "low", ...extra });

describe("Slack notification text (L-5)", () => {
  it("keeps the existing layout for ordinary input", async () => {
    const text = await sentText("定例会議", [item(1, { priority: "high", due_label: "7月5日まで" })]);
    expect(text).toBe(
      ["📝 議事録が生成されました", "定例会議", "✅ アクションアイテム（1件）", "", "[high] 担当1：タスク1（7月5日まで）", "", "minutes-ai により自動生成"].join("\n")
    );
  });

  it("escapes mentions and link syntax in the title and action items", async () => {
    const text = await sentText("<!channel> 緊急 & 重要", [
      item(1, { assignee: "<@U12345>", task: "<!here> 見て <https://evil.example|クリック>" }),
      item(2, { task: "<!subteam^S123> と <!everyone>" }),
    ]);
    for (const raw of ["<!channel>", "<!here>", "<@U12345>", "<!subteam^S123>", "<!everyone>", "<https://evil.example"]) {
      expect(text).not.toContain(raw);
    }
    expect(text).toContain("&lt;!channel&gt; 緊急 &amp; 重要");
    expect(text).toContain("[low] &lt;@U12345&gt;：&lt;!here&gt; 見て &lt;https://evil.example|クリック&gt;（期限未定）");
    // 本文中の < > & はすべてエスケープ済み（生の < が残らない）
    expect(text).not.toMatch(/[<>]/);
  });

  it("limits the number of listed items and notes the remainder", async () => {
    const items = Array.from({ length: 45 }, (_, i) => item(i + 1));
    const text = await sentText("会議", items);
    expect(text).toContain("✅ アクションアイテム（45件）");
    expect(text).toContain("タスク30（");
    expect(text).not.toContain("タスク31（");
    expect(text).toContain("…ほか 15 件（全件は議事録をご確認ください）");
    expect(text.split("\n").filter((l) => l.startsWith("[low]"))).toHaveLength(30);
  });

  it("does not add a remainder line at exactly the limit", async () => {
    const text = await sentText("会議", Array.from({ length: 30 }, (_, i) => item(i + 1)));
    expect(text).not.toContain("ほか");
  });

  it("truncates very long lines before escaping", async () => {
    const text = await sentText("t".repeat(1000), [item(1, { task: "あ".repeat(1000) })]);
    const lines = text.split("\n");
    expect(lines[1]).toBe("t".repeat(300) + "…");
    expect(lines[4].length).toBe(301);
  });
});
