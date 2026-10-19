# 残課題バックログ（Medium 5 件・Low 5 件）

出典: Notion「minutes-ai 設計・実装レビュー（Fable 5, 2026-07-04）」。
High の H-1（/notify の SSRF）・H-2（レート制限）は main に反映済み（PR #1、`5354ca5`）。**2026-10-20 デプロイ済み**。

**対応状況（2026-10-19、ブランチ `claude/p1-medium-low`）**: M-5 / M-1 / M-3 / M-4 / L-2 / L-3 / L-4 / L-5 を対応済み（各項目の ✅ とコミットを参照）。L-1 は現状維持、M-2 は要判断のため未着手。

- 行番号はレビュー時点のもので、ずれている。「現在位置」は 2026-10-12 に main `021305c` で確認した `worker/src/index.js` の位置
- 検証: CI（`.github/workflows/ci.yml`）は worker の `npm run typecheck`（`tsc --checkJs`）と `npm test`（vitest）
- `CLAUDE.md` のルール（BYOK・キーをログに残さない・エラーは日本語・25MB 上限・CORS/プリフライト）を守る
- `buildMinutesPrompt()` の出力フォーマットとレスポンスの形（`AGENTS.md` の API コントラクト）は変えない

## 分類

| 項目 | 内容 | 状態 |
|---|---|---|
| M-5 | 500 応答に `err.message` | ✅ `f3d6a5a` |
| M-1 | CORS のフォールバックが `*` | ✅ `81e806f` |
| M-3 | /minutes の直列実行 | ✅ `496c93b` |
| M-4 | parseActionItems のスキーマ未検証 | ✅ `2411f67` |
| L-1 | マジックバイト検証 | 現状維持（対応しない） |
| L-2〜L-5 | 低優先度の改善 | ✅ L-2 `95504cb` / L-3 `7cd3c1d` / L-4 `39f412a` / L-5 `0a62372` |
| M-2 | /save・/minutes/:id が無認証 | 要判断（D1 を有効化するかどうか） |

## M-5: 500 レスポンスに内部エラー詳細 — ✅ 完了 `f3d6a5a`
- 現在位置: `worker/src/index.js:113`
  `{ error: "サーバー内部でエラーが発生しました。", detail: String(err && err.message || err) }`
- 方針: 本番では `detail` を返さない（ログのみ。キーを含めない）。env フラグでデバッグ時のみ出す形は可
- 実施: `detail` を廃止。例外は `console.error` にのみ出力し、`x-openai-key` / `x-anthropic-key` の値と `sk-…` を `[REDACTED]` に置換。デバッグ用 env フラグは設けていない（`test/error-response.test.js`）

## M-1: CORS フォールバックが `*` — ✅ 完了 `81e806f`
- 現在位置: `worker/src/index.js:44` `const origin = env.ALLOWED_ORIGIN || "*";`
- 方針: 未設定時は `*` に落とさず、ローカル開発用オリジンのみ許可（または明示エラー）。`Vary: Origin` を付与
- 本番の `wrangler.toml` には `ALLOWED_ORIGIN = "https://tomu-ai963.github.io"` が設定済み。挙動を変えないこと
- 実施: 設定時は従来どおりその値を返す。未設定時は Origin が `http://localhost:*` / `http://127.0.0.1:*` / `http://[::1]:*` のときのみ反射し、それ以外は ACAO を付けない。全応答に `Vary: Origin`（`test/cors.test.js`）

## M-3: /minutes の直列実行 — ✅ 完了 `496c93b`
- 現在位置: `handleMinutes`（`worker/src/index.js:175`〜）。Whisper → `callClaude` → `callClaudeActionItems` を順に実行
- 方針: 後ろ2つは文字起こし結果のみに依存するので `Promise.all` で並列化。片方の失敗時の扱いは現在の挙動に合わせる
- 実施: `Promise.allSettled` で並列化。議事録生成の失敗を優先して返し、抽出のエラー応答は `action_items: []`、例外は 500（直列時と同じ）。議事録生成が失敗しても抽出 API は呼ばれる点のみ直列時と異なる（`test/minutes.test.js`）

## M-4: parseActionItems の結果をスキーマ検証していない — ✅ 完了 `2411f67`
- 現在位置: `parseActionItems`（`worker/src/index.js:473`〜）
- 問題: 配列であることしか見ていない。「最初の `[` 〜最後の `]`」の切り出しは前置きの角括弧で誤爆する
- 方針: `{ assignee, task, due, due_label, priority }` へ正規化するバリデータを追加（priority は high/medium/low、due は日付か null）。
  不正要素は落とす。tool use による構造化出力への置き換えは任意（モデル指定は利用者側の BYOK なので互換性に注意）
- 実施: `src/lib/action-items.js` に移設。各 `[` に対応する `]` までを順に試し、要素がすべてオブジェクトの配列を優先。オブジェクトでない要素・task 空の要素は落とし、id は振り直す。assignee 空→"未定"、due は実在する YYYY-MM-DD 以外 null、due_label 空→due→"期限未定"、priority 不正→"medium"（高/中/低も可）。tool use への置き換えはしていない（`test/action-items.test.js`）

## L 群
- L-1: `validateFile`（`index.js:739`）が拡張子・サイズのみ。現状維持で可（対応するならマジックバイト）— **現状維持（対応しない）**
- L-2: Notion タイトルプロパティの総当たり（`callNotionCreatePage`、`index.js:532` の `["タイトル", "Name"]`）→
  `GET /v1/databases/:id` で事前取得する方式へ — ✅ 完了 `95504cb`（type が title のプロパティ名を取得し POST は 1 回。404/401/タイトルなしを個別の日本語エラーに。`test/notion.test.js`）
- L-3: `callWhisper` / `callClaude` の未使用 `origin` 引数、`callClaude` と `callClaudeActionItems` の重複 →
  共通関数 `callAnthropicMessages` に集約 — ✅ 完了 `7cd3c1d`（文言はエンドポイントごとに従来どおり。`test/anthropic.test.js`）
- L-4: 生成日時が UTC（`index.js:317`、`index.js:734` 付近の `toISOString()`）→ Asia/Tokyo で整形 — ✅ 完了 `39f412a`（プロンプトは `YYYY-MM-DD HH:mm (JST)`、`/save` の `created_at` は `+09:00` 付き ISO 8601。`test/datetime.test.js`）
- L-5: Slack 通知本文へのメンション注入（`<!channel>` 等）・件数上限なし → エスケープと件数上限 — ✅ 完了 `0a62372`（`& < >` をエスケープ、最大 30 件＋「…ほか N 件」、1 行 300 文字。`test/slack.test.js`）

## M-2: /save・/minutes/:id が無認証（要判断）
- 現在位置: `handleSave`（`index.js:302`）・`handleGetMinutes`（`index.js:326`）。D1 バインドは未設定で、現状は 501 を返す
- D1 を有効化すると無制限 INSERT・本文サイズ上限なし・UUID を知れば閲覧可能になる
- 方針: D1 有効化と同時に本文サイズ上限＋簡易トークン認証。D1 を使う予定がなければ現状維持
- **D1 を有効化するかが決まるまで着手しない**

## 将来の課金移行への助言（参考）
キー解決の一元化（`resolveKeys`）／前段フック（認証・レート制限・使用量計測）／D1 スキーマへの `user_id`・`usage_log` 追加。
自社キーで課金を始めると H-2 は直接の金銭被害に格上げされる。
