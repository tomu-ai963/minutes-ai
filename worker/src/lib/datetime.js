/**
 * 日時を Asia/Tokyo（JST, UTC+9）で整形する。
 * 日本は 1951 年以降夏時間が無く UTC+9 固定なので、Intl のタイムゾーンデータに依存せず
 * UTC に 9 時間足して UTC のフィールドを読む。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return {
    y: String(d.getUTCFullYear()),
    mo: p(d.getUTCMonth() + 1),
    d: p(d.getUTCDate()),
    h: p(d.getUTCHours()),
    mi: p(d.getUTCMinutes()),
    s: p(d.getUTCSeconds()),
  };
}

/**
 * 表示用（議事録の「日時」）: "2026-10-20 05:30 (JST)"
 * @param {Date} [date]
 */
export function formatJstDisplay(date = new Date()) {
  const t = jstParts(date);
  return `${t.y}-${t.mo}-${t.d} ${t.h}:${t.mi} (JST)`;
}

/**
 * 保存用（ISO 8601、+09:00 オフセット付き）: "2026-10-20T05:30:00+09:00"
 * @param {Date} [date]
 */
export function formatJstIso(date = new Date()) {
  const t = jstParts(date);
  return `${t.y}-${t.mo}-${t.d}T${t.h}:${t.mi}:${t.s}+09:00`;
}
