# AGENTS.md — minutes-ai エージェント向け契約書

このドキュメントは、自律エージェント／統合クライアントが minutes-ai を利用・拡張する際の契約（コントラクト）を定義します。

## 概要
minutes-ai は BYOK（Bring Your Own Key）型の議事録生成ツールです。
音声ファイルを受け取り、文字起こし（OpenAI Whisper）と議事録生成（Anthropic Claude）を行い、構造化された Markdown を返します。

## API コントラクト

ベース URL：デプロイした Cloudflare Worker の URL（例 `https://minutes-ai-worker.<account>.workers.dev`）。

### 認証
APIキーはリクエストヘッダーで渡します。サーバーには保存されません。
- `x-openai-key`: OpenAI APIキー（Whisper 用）
- `x-anthropic-key`: Anthropic APIキー（Claude 用）

### `POST /minutes`（推奨：一括処理）
- Content-Type: `multipart/form-data`
- フィールド：
  - `file`（必須）：音声ファイル（mp3/mp4/wav/m4a、25MB 以下）
  - `language`（任意）：`ja` / `en` など。Whisper の精度向上に使用
  - `model`（任意）：Claude モデル ID の上書き
- ヘッダー：`x-openai-key`, `x-anthropic-key`
- レスポンス（200）：`{ "transcript": "...", "minutes": "# 会議議事録 ...", "action_items": [ ... ] }`
  - `action_items` の各要素：`{ "id": 1, "assignee": "田中さん", "task": "...", "due": "2024-07-05"|null, "due_label": "7月5日まで", "priority": "high"|"medium"|"low" }`

### `POST /extract`（アクションアイテム抽出のみ）
- `application/json`：`{ "transcript": "..." }` または `{ "minutes": "..." }`（`transcript` を優先）、`model`（任意）。ヘッダー `x-anthropic-key`
- レスポンス（200）：`{ "action_items": [ ... ] }`
- JSON パース失敗時も 200 で `{ "action_items": [], "raw": "Claude の生レスポンス" }` を返す。

### `POST /transcribe`（文字起こしのみ）
- `multipart/form-data` の `file`、ヘッダー `x-openai-key`
- レスポンス：`{ "transcript": "..." }`

### `POST /generate`（議事録生成のみ）
- `application/json`：`{ "transcript": "...", "model"?: "..." }`、ヘッダー `x-anthropic-key`
- レスポンス：`{ "minutes": "..." }`

### `POST /notify`（Notion 保存／Slack 通知）
- `application/json`。API キーヘッダーは不要（連携トークンはボディで渡す）。
- リクエスト：
  ```json
  {
    "minutes": "# 会議議事録\n...",
    "action_items": [ { "id": 1, "assignee": "田中", "task": "資料共有", "due_label": "7月5日まで", "priority": "high" } ],
    "title": "2024-07-01 定例会議",
    "notion": { "enabled": true, "token": "secret_xxx", "database_id": "<32桁>" },
    "slack":  { "enabled": true, "webhook_url": "https://hooks.slack.com/services/..." }
  }
  ```
- 処理：`notion.enabled` で Notion ページ作成、`slack.enabled` で Slack 通知。いずれか一方の失敗で全体を中断しない。
- レスポンス（200）：`{ "notion_ok": true, "notion_page_url": "https://www.notion.so/...", "slack_ok": true }`
  - 失敗側は `notion_ok: false, notion_error: "..."` / `slack_ok: false, slack_error: "..."` を含む。
- トークン・Webhook URL はサーバーに保存しない（BYOK）。

### `POST /save` / `GET /minutes/:id`（任意：D1 設定時のみ）
- D1 未設定の場合は `501` を返す。

### `GET /health`
- `{ "ok": true, "service": "minutes-ai-worker" }`

## エラー応答
すべて JSON・日本語メッセージ：`{ "error": "..." }`。
- 400：ファイル未添付 / 非対応形式 / サイズ超過 / 不正なリクエスト形式
- 401：API キー未指定 / 不正
- 429：レート制限・残高不足
- 404：エンドポイント／リソースが見つからない
- 501：未設定の機能（D1 未構成での保存）
- 502：外部 API への接続失敗

## 制約（してはいけないこと・できないこと）
詳細は `agents/capabilities.yaml` を参照。
- 25MB を超えるファイルは処理しない。
- リアルタイム文字起こし、話者分離、Zoom/Teams/Meet 連携は MVP 段階では非対応。
- API キーをサーバー側に保存しない。

## 統合手順
`agents/integration.md` を参照。
