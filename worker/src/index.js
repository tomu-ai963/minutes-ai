/**
 * minutes-ai-worker
 *
 * BYOK（Bring Your Own Key）モデルの議事録生成ツール用 Cloudflare Worker。
 *
 * 役割:
 *   - OpenAI Whisper API へのプロキシ（ブラウザからの直接アクセスは CORS で
 *     ブロックされるため、Worker 経由で中継する）
 *   - Anthropic Claude API を使った議事録生成
 *   - （任意）Cloudflare D1 への議事録保存
 *
 * 重要:
 *   - API キーはリクエストヘッダーで受け取り、その場で外部 API 呼び出しに使うだけ。
 *     Worker / サーバー側には一切保存しない。
 *   - エラーメッセージはすべて日本語で返す。
 *
 * エンドポイント:
 *   POST /transcribe  音声ファイル(multipart/form-data) → 文字起こしテキスト
 *   POST /generate    文字起こしテキスト(JSON) → Markdown 議事録
 *   POST /minutes     /transcribe + /generate を一括実行
 *   POST /save        議事録を D1 に保存（D1 未設定なら 501）
 *   GET  /minutes/:id 保存済み議事録の取得（D1 未設定なら 501）
 *   GET  /health      ヘルスチェック
 */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // Whisper API の上限に合わせて 25MB
const ALLOWED_EXTENSIONS = ["mp3", "mp4", "wav", "m4a"];
const WHISPER_MODEL = "whisper-1";
// ユーザーの Anthropic キーで広く利用可能なモデルを既定値とする。
// フロントエンドから model を渡せば上書き可能。
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    // CORS プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/health") {
        return json({ ok: true, service: "minutes-ai-worker" }, 200, origin);
      }

      if (request.method === "POST" && path === "/transcribe") {
        return await handleTranscribe(request, origin);
      }

      if (request.method === "POST" && path === "/generate") {
        return await handleGenerate(request, origin);
      }

      if (request.method === "POST" && path === "/minutes") {
        return await handleMinutes(request, origin);
      }

      if (request.method === "POST" && path === "/save") {
        return await handleSave(request, env, origin);
      }

      const m = path.match(/^\/minutes\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && m) {
        return await handleGetMinutes(m[1], env, origin);
      }

      return json({ error: "エンドポイントが見つかりません。" }, 404, origin);
    } catch (err) {
      // 想定外の例外は 500 で日本語化して返す
      return json(
        { error: "サーバー内部でエラーが発生しました。", detail: String(err && err.message || err) },
        500,
        origin
      );
    }
  },
};

/* ----------------------------- ハンドラー ----------------------------- */

async function handleTranscribe(request, origin) {
  const openaiKey = getHeaderKey(request, "x-openai-key");
  if (!openaiKey) {
    return json({ error: "OpenAI APIキーが指定されていません。設定画面でキーを入力してください。" }, 401, origin);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "音声ファイルの読み取りに失敗しました。multipart/form-data 形式で送信してください。" }, 400, origin);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "音声ファイルが添付されていません。" }, 400, origin);
  }

  const validation = validateFile(file);
  if (validation) return json({ error: validation }, 400, origin);

  const transcript = await callWhisper(file, openaiKey, form.get("language"), origin);
  if (transcript.error) return json({ error: transcript.error }, transcript.status, origin);

  return json({ transcript: transcript.text }, 200, origin);
}

async function handleGenerate(request, origin) {
  const anthropicKey = getHeaderKey(request, "x-anthropic-key");
  if (!anthropicKey) {
    return json({ error: "Anthropic APIキーが指定されていません。設定画面でキーを入力してください。" }, 401, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエスト形式が不正です。JSON で送信してください。" }, 400, origin);
  }

  const transcript = (body.transcript || "").trim();
  if (!transcript) {
    return json({ error: "文字起こしテキストが空です。" }, 400, origin);
  }

  const result = await callClaude(transcript, anthropicKey, body.model, origin);
  if (result.error) return json({ error: result.error }, result.status, origin);

  return json({ minutes: result.markdown }, 200, origin);
}

// 文字起こし → 議事録生成を一括実行
async function handleMinutes(request, origin) {
  const openaiKey = getHeaderKey(request, "x-openai-key");
  const anthropicKey = getHeaderKey(request, "x-anthropic-key");
  if (!openaiKey) {
    return json({ error: "OpenAI APIキーが指定されていません。設定画面でキーを入力してください。" }, 401, origin);
  }
  if (!anthropicKey) {
    return json({ error: "Anthropic APIキーが指定されていません。設定画面でキーを入力してください。" }, 401, origin);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "音声ファイルの読み取りに失敗しました。multipart/form-data 形式で送信してください。" }, 400, origin);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "音声ファイルが添付されていません。" }, 400, origin);
  }

  const validation = validateFile(file);
  if (validation) return json({ error: validation }, 400, origin);

  const transcript = await callWhisper(file, openaiKey, form.get("language"), origin);
  if (transcript.error) return json({ error: transcript.error }, transcript.status, origin);

  const result = await callClaude(transcript.text, anthropicKey, form.get("model"), origin);
  if (result.error) return json({ error: result.error }, result.status, origin);

  return json({ transcript: transcript.text, minutes: result.markdown }, 200, origin);
}

async function handleSave(request, env, origin) {
  if (!env.DB) {
    return json({ error: "保存機能は未設定です（Cloudflare D1 が構成されていません）。" }, 501, origin);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエスト形式が不正です。JSON で送信してください。" }, 400, origin);
  }
  const markdown = (body.minutes || "").trim();
  if (!markdown) {
    return json({ error: "保存する議事録が空です。" }, 400, origin);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO minutes (id, title, markdown, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, body.title || "無題の議事録", markdown, createdAt)
    .run();
  return json({ id, created_at: createdAt }, 200, origin);
}

async function handleGetMinutes(id, env, origin) {
  if (!env.DB) {
    return json({ error: "保存機能は未設定です（Cloudflare D1 が構成されていません）。" }, 501, origin);
  }
  const row = await env.DB.prepare(
    "SELECT id, title, markdown, created_at FROM minutes WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!row) {
    return json({ error: "指定された議事録が見つかりません。" }, 404, origin);
  }
  return json(row, 200, origin);
}

/* ----------------------------- 外部API呼び出し ----------------------------- */

async function callWhisper(file, openaiKey, language, origin) {
  const upstream = new FormData();
  upstream.append("file", file, file.name || "audio");
  upstream.append("model", WHISPER_MODEL);
  if (language) upstream.append("language", language);

  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: upstream,
    });
  } catch (e) {
    return { error: "文字起こしAPIへの接続に失敗しました。時間をおいて再度お試しください。", status: 502 };
  }

  if (!resp.ok) {
    const msg = await safeErrorMessage(resp);
    if (resp.status === 401) {
      return { error: "OpenAI APIキーが無効です。キーを確認してください。", status: 401 };
    }
    if (resp.status === 429) {
      return { error: "OpenAI APIのレート制限または残高不足です。アカウントをご確認ください。", status: 429 };
    }
    return { error: `文字起こしに失敗しました（${resp.status}）: ${msg}`, status: 502 };
  }

  const data = await resp.json();
  return { text: data.text || "" };
}

async function callClaude(transcript, anthropicKey, model, origin) {
  const prompt = buildMinutesPrompt(transcript);

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model || CLAUDE_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return { error: "議事録生成APIへの接続に失敗しました。時間をおいて再度お試しください。", status: 502 };
  }

  if (!resp.ok) {
    const msg = await safeErrorMessage(resp);
    if (resp.status === 401) {
      return { error: "Anthropic APIキーが無効です。キーを確認してください。", status: 401 };
    }
    if (resp.status === 429) {
      return { error: "Anthropic APIのレート制限です。時間をおいて再度お試しください。", status: 429 };
    }
    return { error: `議事録の生成に失敗しました（${resp.status}）: ${msg}`, status: 502 };
  }

  const data = await resp.json();
  const markdown = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!markdown) {
    return { error: "議事録の生成結果が空でした。もう一度お試しください。", status: 502 };
  }
  return { markdown };
}

function buildMinutesPrompt(transcript) {
  return `あなたは優秀な議事録作成アシスタントです。
以下は会議の文字起こしテキストです。これを読み、構造化された議事録を Markdown 形式で作成してください。

# 出力ルール
- 必ず下記のフォーマットに厳密に従うこと。
- 文字起こしの言語（日本語/英語）に関わらず、議事録は文字起こしと同じ言語で作成すること。
- 推測で事実を作らないこと。情報が無いセクションは「（該当なし）」と書くか、参加者など推定困難なものは省略してよい。
- アクションアイテムは可能な限り「誰が・何を・いつまでに」の形式にすること。
- 出力は議事録の Markdown 本文のみとし、前置きや解説は含めないこと。

# 出力フォーマット
# 会議議事録
日時：[生成日時 — "{{DATE}}" を使用]

## 参加者
（文字起こしから推定できる場合のみ記載。不明な場合は省略）

## 議題・話し合われた内容
（要点を箇条書き）

## 決定事項
（明確に決まったことを箇条書き）

## アクションアイテム
（誰が・何を・いつまでに、の形式で）

## 次回会議
（言及があれば記載）

---
*この議事録はAIにより自動生成されました*

# 文字起こしテキスト
"""
${transcript}
"""`.replace("{{DATE}}", new Date().toISOString());
}

/* ----------------------------- ユーティリティ ----------------------------- */

function validateFile(file) {
  const name = file.name || "";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `非対応のファイル形式です。対応形式: ${ALLOWED_EXTENSIONS.join(" / ")}`;
  }
  if (typeof file.size === "number" && file.size > MAX_FILE_SIZE) {
    return "ファイルサイズが上限（25MB）を超えています。短く分割するか圧縮してください。";
  }
  return null;
}

function getHeaderKey(request, headerName) {
  const v = request.headers.get(headerName);
  return v ? v.trim() : "";
}

async function safeErrorMessage(resp) {
  try {
    const data = await resp.json();
    return (data.error && (data.error.message || data.error.type)) || JSON.stringify(data).slice(0, 300);
  } catch {
    try {
      return (await resp.text()).slice(0, 300);
    } catch {
      return "詳細不明";
    }
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-openai-key, x-anthropic-key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}
