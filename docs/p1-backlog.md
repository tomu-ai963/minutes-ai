# 残課題バックログ（Medium 5 件・Low 5 件）

出典: Notion「minutes-ai 設計・実装レビュー（Fable 5, 2026-07-04）」。
High の H-1（/notify の SSRF）・H-2（レート制限）は main に反映済み（PR #1、`5354ca5`）。**本番デプロイは未実施**。

- 行番号はレビュー時点のもので、ずれている。「現在位置」は 2026-10-12 に main `021305c` で確認した `worker/src/index.js` の位置
- 検証: CI（`.github/workflows/ci.yml`）は worker の `npm run typecheck`（`tsc --checkJs`）と `npm test`（vitest）
- `CLAUDE.md` のルール（BYOK・キーをログに残さない・エラーは日本語・25MB 上限・CORS/プリフライト）を守る
- `buildMinutesPrompt()` の出力フォーマットとレスポンスの形（`AGENTS.md` の API コントラクト）は変えない

## 分類

| 項目 | 内容 | クラウドで実施 |
|---|---|---|
| M-5 | 500 応答に `err.message` | ○ |
| M-1 | CORS のフォールバックが `*` | ○ |
| M-3 | /minutes の直列実行 | ○ |
| M-4 | parseActionItems のスキーマ未検証 | ○ |
| L-1〜L-5 | 低優先度の改善 | ○ |
| M-2 | /save・/minutes/:id が無認証 | 要判断（D1 を有効化するかどうか） |

## M-5: 500 レスポンスに内部エラー詳細
- 現在位置: `worker/src/index.js:113`
  `{ error: "サーバー内部でエラーが発生しました。", detail: String(err && err.message || err) }`
- 方針: 本番では `detail` を返さない（ログのみ。キーを含めない）。env フラグでデバッグ時のみ出す形は可

## M-1: CORS フォールバックが `*`
- 現在位置: `worker/src/index.js:44` `const origin = env.ALLOWED_ORIGIN || "*";`
- 方針: 未設定時は `*` に落とさず、ローカル開発用オリジンのみ許可（または明示エラー）。`Vary: Origin` を付与
- 本番の `wrangler.toml` には `ALLOWED_ORIGIN = "https://tomu-ai963.github.io"` が設定済み。挙動を変えないこと

## M-3: /minutes の直列実行
- 現在位置: `handleMinutes`（`worker/src/index.js:175`〜）。Whisper → `callClaude` → `callClaudeActionItems` を順に実行
- 方針: 後ろ2つは文字起こし結果のみに依存するので `Promise.all` で並列化。片方の失敗時の扱いは現在の挙動に合わせる

## M-4: parseActionItems の結果をスキーマ検証していない
- 現在位置: `parseActionItems`（`worker/src/index.js:473`〜）
- 問題: 配列であることしか見ていない。「最初の `[` 〜最後の `]`」の切り出しは前置きの角括弧で誤爆する
- 方針: `{ assignee, task, due, due_label, priority }` へ正規化するバリデータを追加（priority は high/medium/low、due は日付か null）。
  不正要素は落とす。tool use による構造化出力への置き換えは任意（モデル指定は利用者側の BYOK なので互換性に注意）

## L 群
- L-1: `validateFile`（`index.js:739`）が拡張子・サイズのみ。現状維持で可（対応するならマジックバイト）
- L-2: Notion タイトルプロパティの総当たり（`callNotionCreatePage`、`index.js:532` の `["タイトル", "Name"]`）→
  `GET /v1/databases/:id` で事前取得する方式へ
- L-3: `callWhisper` / `callClaude` の未使用 `origin` 引数、`callClaude` と `callClaudeActionItems` の重複 →
  共通関数 `callAnthropicMessages` に集約
- L-4: 生成日時が UTC（`index.js:317`、`index.js:734` 付近の `toISOString()`）→ Asia/Tokyo で整形
- L-5: Slack 通知本文へのメンション注入（`<!channel>` 等）・件数上限なし → エスケープと件数上限

## M-2: /save・/minutes/:id が無認証（要判断）
- 現在位置: `handleSave`（`index.js:302`）・`handleGetMinutes`（`index.js:326`）。D1 バインドは未設定で、現状は 501 を返す
- D1 を有効化すると無制限 INSERT・本文サイズ上限なし・UUID を知れば閲覧可能になる
- 方針: D1 有効化と同時に本文サイズ上限＋簡易トークン認証。D1 を使う予定がなければ現状維持
- **D1 を有効化するかが決まるまで着手しない**

## 将来の課金移行への助言（参考）
キー解決の一元化（`resolveKeys`）／前段フック（認証・レート制限・使用量計測）／D1 スキーマへの `user_id`・`usage_log` 追加。
自社キーで課金を始めると H-2 は直接の金銭被害に格上げされる。
