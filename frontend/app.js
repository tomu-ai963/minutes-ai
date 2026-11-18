"use strict";
const $ = (id) => document.getElementById(id);

// 既定の Worker。index.html の CSP（connect-src）と必ず揃える。
// 独自の Worker を使う場合は、ここと CSP の両方を書き換える。
const DEFAULT_WORKER_URL = "https://minutes-ai-worker.inverted-triangle-leef.workers.dev";
const ALLOWED_WORKER_ORIGINS = [DEFAULT_WORKER_URL];

const LS = {
  url: "minutesai_worker_url",
  openai: "minutesai_openai_key",
  anthropic: "minutesai_anthropic_key",
  lang: "minutesai_language",
  notionEnabled: "minutesai_notion_enabled",
  notionToken: "minutesai_notion_token",
  notionDbId: "minutesai_notion_db_id",
  slackEnabled: "minutesai_slack_enabled",
  slackWebhook: "minutesai_slack_webhook",
};
// 秘密情報の入力欄。保存済みの値は入力欄に書き戻さず、状態表示（末尾4文字）だけを出す。
const SECRET_FIELDS = [
  { input: "openaiKey", key: LS.openai, state: "openaiKeyState" },
  { input: "anthropicKey", key: LS.anthropic, state: "anthropicKeyState" },
  { input: "notionToken", key: LS.notionToken, state: "notionTokenState" },
  { input: "slackWebhook", key: LS.slackWebhook, state: "slackWebhookState" },
];
const NOTION_URL_PREFIX = "https://www.notion.so/";
const ALLOWED_EXT = ["mp3", "mp4", "wav", "m4a"];
const MAX_SIZE = 25 * 1024 * 1024;
let selectedFile = null;
// 直近に生成されたアクションアイテム（/minutes レスポンスから自動セット）
let currentActionItems = [];
let minutesGenerated = false;
const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" };

/* ---- Worker URL の検証 ---- */
// 戻り値: { url } または { error }（エラー文は日本語）
function validateWorkerUrl(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return { url: DEFAULT_WORKER_URL };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "Worker エンドポイント URL の形式が正しくありません。" };
  }
  if (u.protocol !== "https:") {
    return { error: "Worker エンドポイント URL は https:// で始まる URL を入力してください。" };
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
    return { error: "Worker エンドポイント URL にはパス・クエリ・認証情報を含めないでください。" };
  }
  if (!ALLOWED_WORKER_ORIGINS.includes(u.origin)) {
    return { error: `このページから接続できる Worker は既定の ${DEFAULT_WORKER_URL} のみです。` };
  }
  return { url: u.origin };
}

// 実行時に使う Worker URL。入力欄が不正なら null を返してステータスにエラーを出す。
function getWorkerUrl() {
  const r = validateWorkerUrl($("workerUrl").value);
  if (r.error) { setStatus(r.error, "err"); return null; }
  return r.url;
}

/* ---- 秘密情報 ---- */
function secretValue(f) {
  return $(f.input).value.trim() || localStorage.getItem(f.key) || "";
}
function renderSecretState(f) {
  const saved = localStorage.getItem(f.key) || "";
  const el = $(f.state);
  const input = $(f.input);
  if (!input.dataset.placeholder) input.dataset.placeholder = input.placeholder;
  if (saved) {
    el.textContent = saved.length > 8 ? `設定済み（末尾4文字: ${saved.slice(-4)}）` : "設定済み";
    el.classList.add("set");
    input.placeholder = "変更する場合のみ入力";
  } else {
    el.textContent = "未設定";
    el.classList.remove("set");
    input.placeholder = input.dataset.placeholder;
  }
}

/* ---- 設定の読み書き（localStorage） ---- */
function loadSettings() {
  // 保存済み Worker URL を検証し、許可外（旧 ?worker= で保存された値など）は破棄する
  const storedUrl = localStorage.getItem(LS.url) || "";
  let discarded = false;
  if (storedUrl && validateWorkerUrl(storedUrl).error) {
    localStorage.removeItem(LS.url);
    discarded = true;
  }
  $("workerUrl").value = discarded ? "" : storedUrl;
  $("workerUrl").placeholder = DEFAULT_WORKER_URL;
  SECRET_FIELDS.forEach(renderSecretState);
  $("language").value = localStorage.getItem(LS.lang) || "";
  // 連携設定
  $("notionEnabled").checked = localStorage.getItem(LS.notionEnabled) === "1";
  $("notionDbId").value = localStorage.getItem(LS.notionDbId) || "";
  $("slackEnabled").checked = localStorage.getItem(LS.slackEnabled) === "1";
  syncIntegrationFields();
  updateSendButton();
  if (discarded) {
    setStatus("保存されていた Worker URL は許可されていないため破棄し、既定の Worker に戻しました。", "err");
  }
}
function saveSettings() {
  const raw = $("workerUrl").value.trim();
  const r = validateWorkerUrl(raw);
  if (r.error) { setStatus(r.error, "err"); return; }
  if (raw) localStorage.setItem(LS.url, r.url);
  else localStorage.removeItem(LS.url);
  $("workerUrl").value = raw ? r.url : "";

  // 秘密情報は入力があったときだけ上書きし、保存後は入力欄を空に戻す
  SECRET_FIELDS.forEach((f) => {
    const v = $(f.input).value.trim();
    if (v) localStorage.setItem(f.key, v);
    $(f.input).value = "";
    renderSecretState(f);
  });
  localStorage.setItem(LS.lang, $("language").value);
  localStorage.setItem(LS.notionEnabled, $("notionEnabled").checked ? "1" : "0");
  localStorage.setItem(LS.notionDbId, $("notionDbId").value.trim());
  localStorage.setItem(LS.slackEnabled, $("slackEnabled").checked ? "1" : "0");
  updateSendButton();
  setStatus("設定を保存しました。", "ok");
}
function clearSettings() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  SECRET_FIELDS.forEach((f) => { $(f.input).value = ""; });
  loadSettings();
  setStatus("保存した設定を消去しました。", "ok");
}

/* ---- 連携設定のフィールド表示切り替え ---- */
function syncIntegrationFields() {
  $("notionFields").style.display = $("notionEnabled").checked ? "block" : "none";
  $("slackFields").style.display = $("slackEnabled").checked ? "block" : "none";
}

/* ---- ステータス表示（innerHTML を使わない） ---- */
function setStatus(msg, kind, busy) {
  const el = $("status");
  el.className = kind || "";
  el.replaceChildren();
  if (busy) {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.appendChild(sp);
  }
  if (msg) el.appendChild(document.createTextNode(msg));
}

/* ---- ファイル選択 ---- */
function pickFile(file) {
  if (!file) return;
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXT.includes(ext)) {
    setStatus("非対応のファイル形式です。対応形式: mp3 / mp4 / wav / m4a", "err");
    selectedFile = null; $("runBtn").disabled = true; $("filename").textContent = "";
    return;
  }
  if (file.size > MAX_SIZE) {
    setStatus("ファイルサイズが上限（25MB）を超えています。", "err");
    selectedFile = null; $("runBtn").disabled = true; $("filename").textContent = "";
    return;
  }
  selectedFile = file;
  $("filename").textContent = `選択中: ${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB）`;
  $("runBtn").disabled = false;
  setStatus("");
}

/* ---- 議事録生成（Worker の /minutes を呼ぶ） ---- */
async function run() {
  const url = getWorkerUrl();
  if (!url) return;
  const openaiKey = secretValue(SECRET_FIELDS[0]);
  const anthropicKey = secretValue(SECRET_FIELDS[1]);

  if (!openaiKey) { setStatus("OpenAI APIキーを入力してください。", "err"); return; }
  if (!anthropicKey) { setStatus("Anthropic APIキーを入力してください。", "err"); return; }
  if (!selectedFile) { setStatus("音声ファイルを選択してください。", "err"); return; }

  $("runBtn").disabled = true;
  setStatus("文字起こし・議事録を生成しています…（音声の長さによっては数分かかります）", "work", true);

  const fd = new FormData();
  fd.append("file", selectedFile);
  const lang = $("language").value;
  if (lang) fd.append("language", lang);

  try {
    const resp = await fetch(url + "/minutes", {
      method: "POST",
      headers: { "x-openai-key": openaiKey, "x-anthropic-key": anthropicKey },
      body: fd,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setStatus(data.error || `エラーが発生しました（${resp.status}）。`, "err");
      return;
    }
    $("output").textContent = data.minutes || "";
    $("transcript").textContent = data.transcript || "";
    $("outputWrap").style.display = "block";
    // アクションアイテムを保持・表示する
    currentActionItems = Array.isArray(data.action_items) ? data.action_items : [];
    renderActionItems(currentActionItems);
    minutesGenerated = true;
    updateSendButton();
    setStatus("議事録を生成しました。", "ok");
    $("outputWrap").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    setStatus("通信に失敗しました。Worker の URL と CORS 設定をご確認ください。", "err");
  } finally {
    $("runBtn").disabled = false;
  }
}

/* ---- アクションアイテム表示 ---- */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function renderActionItems(items) {
  $("actionItemsWrap").style.display = "block";
  const body = $("actionItemsBody");
  if (!Array.isArray(items) || items.length === 0) {
    body.innerHTML = '<p class="empty-note">アクションアイテムはありませんでした。</p>';
    return;
  }
  const rows = items.map((it) => {
    const prio = ["high", "medium", "low"].includes(it.priority) ? it.priority : "medium";
    const prioLabel = PRIORITY_LABEL[prio] || "中";
    const isUnset = !it.assignee || it.assignee === "未定";
    const assigneeCell = isUnset
      ? '<span class="assignee-unset">未定</span>'
      : escapeHtml(it.assignee);
    const due = it.due_label || it.due || "期限未定";
    return `<tr>
      <td><span class="badge ${prio}">${prioLabel}</span></td>
      <td>${assigneeCell}</td>
      <td class="task">${escapeHtml(it.task)}</td>
      <td>${escapeHtml(due)}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `<div class="table-wrap">
    <table class="action-items">
      <thead>
        <tr><th>優先度</th><th>担当者</th><th>タスク</th><th>期限</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/* ---- CSV ダウンロード（BOM付き UTF-8・Excel 日本語対応） ---- */
function csvEscape(value) {
  const s = String(value == null ? "" : value);
  // ダブルクォート・カンマ・改行を含む場合はクォートで囲む
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function downloadCsv() {
  if (!currentActionItems.length) {
    setStatus("ダウンロードできるアクションアイテムがありません。", "err");
    return;
  }
  const header = ["No", "担当者", "タスク", "期限", "優先度"];
  const lines = [header.map(csvEscape).join(",")];
  currentActionItems.forEach((it, i) => {
    const due = it.due_label || it.due || "期限未定";
    const prioLabel = PRIORITY_LABEL[it.priority] || it.priority || "中";
    lines.push([
      csvEscape(it.id != null ? it.id : i + 1),
      csvEscape(it.assignee || "未定"),
      csvEscape(it.task || ""),
      csvEscape(due),
      csvEscape(prioLabel),
    ].join(","));
  });
  // CRLF 改行 + 先頭 BOM で Excel との互換性を高める
  const csv = "﻿" + lines.join("\r\n");
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `action-items-${stamp}.csv`);
}

/* ---- Notion / Slack 連携 ---- */
// 送信ボタンの表示/有効状態を更新する。
// 両方OFF → 非表示。少なくとも一方ON かつ議事録生成済み → 有効。
function updateSendButton() {
  const notionOn = $("notionEnabled").checked;
  const slackOn = $("slackEnabled").checked;
  const btn = $("sendBtn");
  if (!notionOn && !slackOn) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "";
  btn.disabled = !minutesGenerated;
}

// 議事録の先頭の見出し行（# ...）からタイトルを抽出。無ければ日付ベースで生成。
function deriveTitle() {
  const md = $("output").textContent || "";
  const m = md.match(/^#\s+(.+)$/m);
  if (m && m[1].trim()) return m[1].trim();
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `議事録_${stamp}`;
}

// Notion のページ URL は https://www.notion.so/ で始まる場合のみリンクにする
function isNotionPageUrl(u) {
  return typeof u === "string" && u.startsWith(NOTION_URL_PREFIX);
}

async function sendToIntegrations() {
  const url = getWorkerUrl();
  if (!url) return;

  const notionEnabled = $("notionEnabled").checked;
  const slackEnabled = $("slackEnabled").checked;
  if (!notionEnabled && !slackEnabled) {
    setStatus("Notion・Slack のいずれかを有効にしてください。", "err");
    return;
  }

  const payload = {
    minutes: $("output").textContent || "",
    action_items: currentActionItems,
    title: deriveTitle(),
    notion: {
      enabled: notionEnabled,
      token: secretValue(SECRET_FIELDS[2]),
      database_id: $("notionDbId").value.trim(),
    },
    slack: {
      enabled: slackEnabled,
      webhook_url: secretValue(SECRET_FIELDS[3]),
    },
  };

  $("sendBtn").disabled = true;
  setStatus("Notion / Slack に送信しています…", "work", true);

  try {
    const resp = await fetch(url + "/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setStatus(data.error || `エラーが発生しました（${resp.status}）。`, "err");
      return;
    }

    // 結果メッセージを DOM で組み立てる（サーバー由来の文字列は textContent で挿入）
    const parts = [];
    let anyFail = false;
    if (notionEnabled) {
      if (data.notion_ok) {
        if (isNotionPageUrl(data.notion_page_url)) {
          const span = document.createElement("span");
          span.append("✅ ");
          const a = document.createElement("a");
          a.href = data.notion_page_url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Notionページを開く";
          span.appendChild(a);
          parts.push(span);
        } else {
          parts.push("✅ Notionに保存しました");
        }
      } else {
        anyFail = true;
        parts.push(`⚠️ Notion保存失敗: ${data.notion_error || "不明なエラー"}`);
      }
    }
    if (slackEnabled) {
      if (data.slack_ok) {
        parts.push("Slackに通知しました");
      } else {
        anyFail = true;
        parts.push(`⚠️ Slack通知失敗: ${data.slack_error || "不明なエラー"}`);
      }
    }

    const el = $("status");
    el.className = anyFail ? "err" : "ok";
    el.replaceChildren();
    parts.forEach((p, i) => {
      if (i > 0) el.append(" / ");
      el.append(p);
    });
  } catch (e) {
    setStatus("通信に失敗しました。Worker の URL と CORS 設定をご確認ください。", "err");
  } finally {
    updateSendButton();
  }
}

/* ---- コピー / ダウンロード ---- */
async function copyOutput() {
  const text = $("output").textContent;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("議事録をコピーしました。", "ok");
  } catch {
    setStatus("コピーに失敗しました。手動で選択してコピーしてください。", "err");
  }
}
function downloadOutput() {
  const text = $("output").textContent;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadBlob(new Blob([text], { type: "text/markdown;charset=utf-8" }), `議事録_${stamp}.md`);
}

/* ---- イベント登録 ---- */
function init() {
  // ?worker= による Worker URL の取り込みは廃止（第三者が細工したリンクで
  // 送信先を差し替えられ、APIキーが漏れるのを防ぐ）。クエリは無視する。
  loadSettings();
  $("saveSettings").addEventListener("click", saveSettings);
  $("clearSettings").addEventListener("click", clearSettings);
  $("runBtn").addEventListener("click", run);
  $("copyBtn").addEventListener("click", copyOutput);
  $("downloadBtn").addEventListener("click", downloadOutput);
  $("csvBtn").addEventListener("click", downloadCsv);
  $("sendBtn").addEventListener("click", sendToIntegrations);
  // 連携チェックボックス：フィールド表示と送信ボタン状態を更新
  $("notionEnabled").addEventListener("change", () => { syncIntegrationFields(); updateSendButton(); });
  $("slackEnabled").addEventListener("change", () => { syncIntegrationFields(); updateSendButton(); });

  const dz = $("dropzone");
  dz.addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => pickFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
  );
  dz.addEventListener("drop", (e) => pickFile(e.dataTransfer.files[0]));
}
init();
