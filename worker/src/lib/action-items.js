/**
 * アクションアイテム（Claude の出力）のパースと正規化。
 *
 * 出力スキーマ（AGENTS.md の API コントラクト）:
 *   { id, assignee, task, due, due_label, priority }
 *   - id: 1 始まりの連番（正規化後に振り直す）
 *   - assignee: 文字列（不明なら "未定"）
 *   - task: 空でない文字列（無い要素は落とす）
 *   - due: "YYYY-MM-DD"（実在する日付）または null
 *   - due_label: 文字列（不明なら due、それも無ければ "期限未定"）
 *   - priority: "high" | "medium" | "low"（不明・不正なら "medium"）
 */

const PRIORITIES = ["high", "medium", "low"];
const PRIORITY_ALIASES = { 高: "high", 中: "medium", 低: "low" };
// 角括弧の候補を探す回数の上限（巨大な入力での二乗オーダーの走査を避ける）
const MAX_BRACKET_CANDIDATES = 50;

/**
 * Claude の出力（理想は純粋な JSON 配列）から配列を取り出し、正規化して返す。
 * 配列が見つからなければ null（呼び出し側でパース失敗として扱う）。
 * @param {string} rawText
 * @returns {Array<{ id: number, assignee: string, task: string, due: string|null, due_label: string, priority: string }>|null}
 */
export function parseActionItems(rawText) {
  if (!rawText) return [];
  const arr = extractJsonArray(rawText);
  return arr ? normalizeActionItems(arr) : null;
}

/**
 * テキストから JSON 配列を取り出す。
 * 候補の順序: 全体 → コードフェンス内 → 各 "[" から対応する "]" までの範囲。
 * 前置きの "[注意]" や "[1]" のような角括弧に誤爆しないよう、要素がすべてオブジェクトの
 * 配列を優先し、無ければ最初に見つかった配列を返す。
 * @param {string} rawText
 * @returns {any[]|null}
 */
export function extractJsonArray(rawText) {
  /** @type {any[]|null} */
  let fallback = null;
  for (const c of candidates(rawText)) {
    let v;
    try {
      v = JSON.parse(c);
    } catch {
      continue;
    }
    if (!Array.isArray(v)) continue;
    if (v.every(isPlainObject)) return v;
    if (!fallback) fallback = v;
  }
  return fallback;
}

function* candidates(text) {
  yield text.trim();

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fenceRe)) yield m[1].trim();

  let tried = 0;
  for (let i = text.indexOf("["); i !== -1 && tried < MAX_BRACKET_CANDIDATES; i = text.indexOf("[", i + 1)) {
    const end = matchingBracket(text, i);
    if (end === -1) continue;
    tried++;
    yield text.slice(i, end + 1);
  }
}

// text[start] の "[" に対応する "]" の位置を返す（JSON 文字列リテラル内の括弧は無視）。無ければ -1。
function matchingBracket(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 配列の各要素をスキーマに正規化する。オブジェクトでない要素・task が空の要素は落とす。
 * @param {any[]} items
 */
export function normalizeActionItems(items) {
  const out = [];
  for (const it of items) {
    if (!isPlainObject(it)) continue;
    const task = nonEmptyString(it.task);
    if (!task) continue;
    const due = normalizeDue(it.due);
    out.push({
      id: out.length + 1,
      assignee: nonEmptyString(it.assignee) || "未定",
      task,
      due,
      due_label: nonEmptyString(it.due_label) || due || "期限未定",
      priority: normalizePriority(it.priority),
    });
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" ? v.trim() : "";
}

// "YYYY-MM-DD"（後ろに時刻が付いていても日付部分のみ採用）で、実在する日付なら返す。それ以外は null。
function normalizeDue(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizePriority(v) {
  if (typeof v !== "string") return "medium";
  const s = v.trim().toLowerCase();
  if (PRIORITIES.includes(s)) return s;
  return PRIORITY_ALIASES[s] || "medium";
}
