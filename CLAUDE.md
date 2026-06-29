# CLAUDE.md — minutes-ai

このファイルは Claude Code（および他のコーディングエージェント）がこのリポジトリで作業する際の指示書です。

## プロジェクトの性質
- **BYOK モデル**：ユーザー自身の API キーを使う。サービス側はキーを保持しない。
- 音声ファイルをアップロード → Whisper で文字起こし → Claude で議事録生成、という一連の流れを提供する。
- 認証は無し（MVP 段階）。

## アーキテクチャ
- **Frontend**：`frontend/index.html`（単一ファイルの静的サイト。GitHub Pages で配信）。
- **Backend**：`worker/src/index.js`（Cloudflare Workers）。
- **文字起こし**：OpenAI Whisper API（`whisper-1`）。
- **議事録生成**：Anthropic Claude API（既定 `claude-sonnet-4-6`）。
- **ストレージ**：Cloudflare D1（任意。議事録の保存に使用。未設定でも本体機能は動作）。

## 必ず守るルール
1. **APIキーはフロントエンドの localStorage に保存する**こと。サーバー（Worker / D1）には保存しない。
2. **Whisper API へはブラウザから直接アクセスしない**。CORS の問題があるため、必ず Cloudflare Worker 経由でプロキシする。
3. **ファイルサイズ上限は 25MB**（Whisper API の制限に合わせる）。フロントとワーカーの両方で検証する。
4. **エラーメッセージはすべて日本語**で表示する。
5. API キーは**リクエストヘッダー**（`x-openai-key` / `x-anthropic-key`）で受け取り、その場の外部 API 呼び出しにのみ使用する。ログにも残さない。
6. **CORS ヘッダーを適切に設定**する。プリフライト（OPTIONS）にも応答する。

## エラーハンドリングの方針
以下を個別に判定して日本語で返す：
- ファイルサイズ超過（25MB 超）
- 非対応形式（mp3/mp4/wav/m4a 以外）
- API キー未指定 / 不正（401）
- レート制限・残高不足（429）

## 議事録の出力フォーマット
`worker/src/index.js` の `buildMinutesPrompt()` が定義するフォーマットを正とする。
見出し構成：会議議事録 / 日時 / 参加者 / 議題・話し合われた内容 / 決定事項 / アクションアイテム / 次回会議。
末尾に `*この議事録はAIにより自動生成されました*` を付ける。

## デプロイ
- Worker：`cd worker && wrangler deploy`
- Frontend：`frontend/index.html` を GitHub Pages で公開し、画面上の「Worker エンドポイント URL」にデプロイ済み Worker の URL を設定する。

## v2 追加機能（2026-06-30）
- `POST /extract`：アクションアイテムのJSON抽出エンドポイント（`buildActionItemsPrompt()` を使用。`transcript` または `minutes` を受け取る）。
- `POST /minutes` レスポンスに `action_items` フィールドを追加（議事録生成後に同じ文字起こしから順次抽出）。
- フロントエンドにアクションアイテムテーブル＋CSVダウンロード機能を追加（優先度バッジ：high=赤 / medium=黄 / low=緑）。
- CSVはBOM付きUTF-8（Excelで直接開けるよう対応）。カラム：`No,担当者,タスク,期限,優先度`。

## v3 追加機能（2026-06-30）
- `POST /notify`：Notion保存＋Slack通知エンドポイント。
  - `notion.enabled=true` → Notion API（`/v1/pages`, `Notion-Version: 2022-06-28`）でページ作成（議事録本文を paragraph に2000文字ごと分割＋アクションアイテムを heading_2「✅ アクションアイテム」＋ bulleted_list_item）。タイトルプロパティ名は「タイトル」→「Name」のフォールバック。
  - `slack.enabled=true` → Incoming Webhook にシンプルな text 形式で通知。
  - トークン・Webhook URL はリクエストボディで受け取り、サーバーには保存しない（BYOK）。Notion 失敗時も Slack は継続。
- フロントエンド設定画面に Notion / Slack 連携の ON/OFF 設定（チェックでフィールド表示）を追加。
- 議事録生成後に「📤 Notion & Slackに送る」ボタンで手動送信。Notionページ作成時は `notion_page_url` をリンク表示。
