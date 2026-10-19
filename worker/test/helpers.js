// テスト共通ヘルパー。
import { vi } from "vitest";

// レート制限（メモリ版）はプロセス内で共有されるため、テストごとに別 IP を払い出す。
let ipSeq = 0;
export function nextIp() {
  ipSeq++;
  return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

export function jsonReq(path, { method = "POST", headers = {}, body, ip = nextIp() } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function formReq(path, { headers = {}, fields = {}, file, ip = nextIp() } = {}) {
  const fd = new FormData();
  if (file) fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": ip, ...headers },
    body: fd,
  });
}

export function audioFile(name = "meeting.mp3") {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "audio/mpeg" });
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Anthropic Messages API の成功応答
export function anthropicText(text) {
  return jsonResponse({ content: [{ type: "text", text }] });
}

// 議事録生成プロンプトかアクションアイテム抽出プロンプトかを判定する
export function anthropicKind(init) {
  const body = JSON.parse(String(init && init.body));
  const prompt = body.messages[0].content;
  if (prompt.includes("議事録作成アシスタント")) return "minutes";
  if (prompt.includes("アクションアイテムを抽出")) return "actions";
  return "unknown";
}

// URL に応じて応答を返す fetch モック。routes は (url, init) => Response | Promise<Response> | undefined の配列。
// どのルートにも当たらない呼び出しはテストの失敗として扱えるよう例外にする。
export function mockFetch(...routes) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// DoH（cloudflare-dns.com）に公開 IP を返すルート。safeFetch 経由の Slack 送信テスト用。
export function dohPublic(ip = "93.184.216.34") {
  return (url) => {
    if (!url.startsWith("https://cloudflare-dns.com/dns-query")) return undefined;
    const isA = url.includes("type=A&") || url.endsWith("type=A");
    return jsonResponse({ Status: 0, Answer: isA ? [{ type: 1, data: ip }] : [] });
  };
}
