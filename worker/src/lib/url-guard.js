/**
 * url-guard.js — SSRF 対策ユーティリティ
 *
 * ユーザー指定の Webhook URL（`/notify` の Slack Webhook 等）を外部送信する前に、
 * 宛先が内部ネットワーク・予約帯域でないことを検証する。
 *
 * 設計方針（knowledge-rag の `lib/url-guard.ts` を JS 版として踏襲）:
 *   - fail-closed：判定に迷う入力（パース不能・解決不能）は全て拒否する。
 *   - 難読化 IP 表記（10 進 / 16 進 / 8 進 / inet_aton、IPv4-mapped/compat IPv6、
 *     NAT64、6to4、fc00::/7 等）を正規化してから判定する。
 *   - リダイレクトは手動追従（redirect: 'manual'）し、追従先ごとに再検証する。
 *   - レスポンスサイズ上限・タイムアウトを設定する。
 *
 * 残余リスク（README にも記載）:
 *   Cloudflare Workers ランタイムには同期的な DNS 解決 API が無いため、ホスト名は
 *   DNS-over-HTTPS で解決してから検証する。fetch 実体が使う解決結果と検証時の解決結果が
 *   異なりうる（DNS リバインディング / TOCTOU）残余リスクは完全には排除できない。
 *   テストでは `resolve` を注入して決定的に検証する。
 */

export class SsrfError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SsrfError";
  }
}

/* ----------------------------- IP パース ----------------------------- */

// 10進 / 16進(0x) / 8進(0) の各パートを数値化する（inet_aton 互換）。
/** @param {string} p @returns {number|null} */
function parseIntFlexible(p) {
  if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (/^0$/.test(p)) return 0;
  if (/^[1-9][0-9]*$/.test(p)) return parseInt(p, 10);
  return null;
}

// IPv4（inet_aton 形式含む）を 4 バイト配列に正規化する。非該当は null。
/** @param {string} str @returns {number[]|null} */
function parseIpv4(str) {
  if (str === "") return null;
  const parts = str.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const nums = [];
  for (const p of parts) {
    const n = parseIntFlexible(p);
    if (n === null || n < 0) return null;
    nums.push(n);
  }

  let value;
  if (nums.length === 1) {
    value = nums[0];
  } else if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
    value = nums[0] * 0x1000000 + nums[1];
  } else if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
    value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
  } else {
    if (nums.some((n) => n > 0xff)) return null;
    value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  }

  if (value < 0 || value > 0xffffffff) return null;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// IPv6 内に埋め込まれた末尾 IPv4（例: ::ffff:1.2.3.4）用の厳密ドット10進パース。
/** @param {string} p @returns {number[]|null} */
function parseDottedV4Strict(p) {
  const m = p.split(".");
  if (m.length !== 4) return null;
  const out = [];
  for (const x of m) {
    if (!/^[0-9]{1,3}$/.test(x)) return null;
    const n = parseInt(x, 10);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// IPv6 を 16 バイト配列に正規化する（:: 圧縮・末尾 IPv4 埋め込み対応）。非該当は null。
/** @param {string} str @returns {number[]|null} */
function parseIpv6(str) {
  let s = str.split("%")[0]; // ゾーン ID を除去
  if (s.indexOf(":") === -1) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  if ((s.match(/::/g) || []).length > 1) return null;

  // 末尾の IPv4 表記を 2 つの 16bit グループへ変換
  if (s.indexOf(".") !== -1) {
    const lc = s.lastIndexOf(":");
    if (lc === -1) return null;
    const v4 = parseDottedV4Strict(s.slice(lc + 1));
    if (!v4) return null;
    const h1 = ((v4[0] << 8) | v4[1]).toString(16);
    const h2 = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lc + 1) + h1 + ":" + h2;
  }

  let head;
  let tail = null;
  if (s.includes("::")) {
    const [a, b] = s.split("::");
    head = a === "" ? [] : a.split(":");
    tail = b === "" ? [] : b.split(":");
  } else {
    head = s.split(":");
  }

  /** @param {string[]} groups */
  const toWords = (groups) => {
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const headWords = toWords(head);
  if (headWords === null) return null;

  let full;
  if (tail !== null) {
    const tailWords = toWords(tail);
    if (tailWords === null) return null;
    const missing = 8 - headWords.length - tailWords.length;
    if (missing < 0) return null;
    full = [...headWords, ...Array(missing).fill(0), ...tailWords];
  } else {
    if (headWords.length !== 8) return null;
    full = headWords;
  }

  if (full.length !== 8) return null;
  const bytes = [];
  for (const g of full) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * ホスト名がリテラル IP なら正規化して返す。ホスト名（FQDN）なら null。
 * @param {string} host
 * @returns {{ version: 4|6, bytes: number[] }|null}
 */
export function parseIp(host) {
  const v4 = parseIpv4(host);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(host);
  if (v6) return { version: 6, bytes: v6 };
  return null;
}

/* ----------------------------- 禁止帯域判定 ----------------------------- */

/** @param {number[]} b */
function isBlockedV4(b) {
  const [a, b1, c] = b;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 ループバック
  if (a === 169 && b1 === 254) return true; // 169.254.0.0/16 リンクローカル
  if (a === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b1 === 168) return true; // 192.168.0.0/16
  if (a === 192 && b1 === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b1 === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b1 === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b1 === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b1 === 0 && c === 113) return true; // TEST-NET-3
  if (a === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224/4 マルチキャスト + 240/4 予約 + 255.255.255.255
  return false;
}

/** @param {number[]} b @param {number} start */
function allZero(b, start, end) {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

/** @param {number[]} b */
function isBlockedV6(b) {
  if (allZero(b, 0, 16)) return true; // :: 未指定
  if (allZero(b, 0, 15) && b[15] === 1) return true; // ::1 ループバック
  // ::ffff:0:0/96 IPv4-mapped → 埋め込み v4 で判定
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(b.slice(12, 16));
  // 64:ff9b::/96 NAT64 → 埋め込み v4 で判定
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return isBlockedV4(b.slice(12, 16));
  }
  // ::/96 IPv4-compatible（廃止済み）→ 埋め込み v4 で判定
  if (allZero(b, 0, 12)) return isBlockedV4(b.slice(12, 16));
  // 2002::/16 6to4 → 埋め込み v4（bytes 2..6）で判定
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(b.slice(2, 6));
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 リンクローカル
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 ユニークローカル
  if (b[0] === 0xff) return true; // ff00::/8 マルチキャスト
  return false;
}

/**
 * 正規化済み IP が内部・予約帯域なら true。
 * @param {{ version: 4|6, bytes: number[] }} ip
 */
export function isBlockedIp(ip) {
  return ip.version === 4 ? isBlockedV4(ip.bytes) : isBlockedV6(ip.bytes);
}

/* ----------------------------- DNS 解決 ----------------------------- */

// DNS-over-HTTPS でホスト名を解決する（本番既定のリゾルバ）。
/** @param {string} hostname @returns {Promise<string[]>} */
async function dohResolve(hostname) {
  const out = [];
  for (const type of ["A", "AAAA"]) {
    const u = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    let r;
    try {
      r = await fetch(u, { headers: { accept: "application/dns-json" } });
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.Answer)) continue;
    for (const ans of j.Answer) {
      if (ans.type === 1 || ans.type === 28) out.push(String(ans.data));
    }
  }
  return out;
}

const BLOCKED_HOSTNAMES = new Set(["localhost"]);

/**
 * URL が外部送信して安全な公開宛先か検証する。危険なら SsrfError を投げる。
 * @param {string} rawUrl
 * @param {{ resolve?: (h: string) => Promise<string[]> }} [opts]
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(rawUrl, opts = {}) {
  const resolve = opts.resolve || dohResolve;

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError("URL の形式が不正です。");
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SsrfError("http/https 以外のスキームは許可されていません。");
  }
  if (u.username || u.password) {
    throw new SsrfError("認証情報を含む URL は許可されていません。");
  }

  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw new SsrfError("内部ホスト宛の URL は許可されていません。");
  }

  // リテラル IP はその場で判定（DNS 解決不要）
  const literal = parseIp(host);
  if (literal) {
    if (isBlockedIp(literal)) {
      throw new SsrfError("内部・予約 IP アドレス宛の URL は許可されていません。");
    }
    return u;
  }

  // FQDN は解決して全 A/AAAA レコードを検証（fail-closed）
  const addrs = await resolve(host);
  if (!addrs || addrs.length === 0) {
    throw new SsrfError("ホスト名を解決できませんでした。");
  }
  for (const a of addrs) {
    const ip = parseIp(a);
    if (!ip || isBlockedIp(ip)) {
      throw new SsrfError("宛先が内部・予約 IP アドレスに解決されました。");
    }
  }
  return u;
}

/* ----------------------------- 安全な fetch ----------------------------- */

// レスポンス本文を maxBytes まで読み取り、超過なら SsrfError。
/** @param {Response} resp @param {number} maxBytes */
async function readCapped(resp, maxBytes) {
  const cl = resp.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw new SsrfError("応答サイズが上限を超えました。");
  }
  if (!resp.body) {
    return { ok: resp.ok, status: resp.status, text: "" };
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new SsrfError("応答サイズが上限を超えました。");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return { ok: resp.ok, status: resp.status, text: new TextDecoder().decode(buf) };
}

/**
 * SSRF 検証付き fetch。リダイレクトを手動追従し追従先を再検証する。
 * 戻り値は軽量な { ok, status, text }。
 * @param {string} rawUrl
 * @param {RequestInit} [options]
 * @param {{ resolve?: (h: string) => Promise<string[]>, maxBytes?: number, timeoutMs?: number, maxRedirects?: number }} [cfg]
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
export async function safeFetch(rawUrl, options = {}, cfg = {}) {
  const resolve = cfg.resolve;
  const maxBytes = cfg.maxBytes ?? 1024 * 1024; // 1MB
  const timeoutMs = cfg.timeoutMs ?? 5000;
  const maxRedirects = cfg.maxRedirects ?? 5;

  let current = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertPublicUrl(current, { resolve });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(u.toString(), { ...options, redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return await readCapped(resp, maxBytes);
      current = new URL(loc, u).toString(); // 相対 Location を解決し次ループで再検証
      continue;
    }
    return await readCapped(resp, maxBytes);
  }
  throw new SsrfError("リダイレクト回数が上限を超えました。");
}
