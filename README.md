# minutes-ai 📝

BYOK（Bring Your Own Key）モデルの **AI議事録自動生成ツール**。
音声ファイルをアップロードするだけで、文字起こし → 構造化された議事録（Markdown）を生成します。

- **Frontend**：静的サイト（`index.html` + `app.js` + `style.css`。GitHub Pages）
- **Backend**：Cloudflare Workers
- **文字起こし**：OpenAI Whisper API（ユーザーのキー）
- **議事録生成**：Anthropic Claude API（ユーザーのキー）
- **ストレージ**：なし（議事録は Worker に保存しない。残す場合は Notion・Slack 連携を使う）

APIキーは**ブラウザの localStorage にのみ保存**され、サーバーには保存されません。

---

## 🔗 公開URL

| 種別 | URL |
|------|-----|
| 公開サイト（GitHub Pages） | https://tomu-ai963.github.io/minutes-ai/ |
| Worker API（Cloudflare） | https://minutes-ai-worker.inverted-triangle-leef.workers.dev |

### Worker の設定について
公開サイトは既定で上記の Worker に接続します。開いて API キーを入力するだけで使えます。

> 以前の `?worker=<Worker URL>` による自動設定は廃止しました（細工したリンクで送信先を差し替えられ、API キーが第三者の Worker に送られるのを防ぐため）。クエリに付けても無視されます。
> 以前の方式で許可外の Worker URL が保存されていた場合は、次回表示時に破棄して既定の Worker に戻します。

---

## ディレクトリ構成
```
minutes-ai/
├── CLAUDE.md              # Claude Code への指示書
├── AGENTS.md              # エージェント向け契約書
├── README.md              # このファイル
├── llms.txt               # AI向けインデックス
├── agents/
│   ├── capabilities.yaml  # できること・できないこと
│   └── integration.md     # エージェント統合手順
├── frontend/
│   ├── index.html         # 画面（CSP メタタグ付き）
│   ├── app.js             # 画面のロジック（インライン JS は置かない）
│   └── style.css          # スタイル（インライン style は置かない）
└── worker/
    ├── src/index.js       # Cloudflare Workers 本体
    └── wrangler.toml
```

---

## セットアップ手順

### 必要なもの
- [Node.js](https://nodejs.org/)（18 以上）
- Cloudflare アカウント＋ [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm i -g wrangler`）
- OpenAI APIキー（Whisper 用）／ Anthropic APIキー（Claude 用）

### 1. Worker をデプロイ
```bash
cd worker
wrangler login
wrangler deploy
```
デプロイ後に表示される URL（例 `https://minutes-ai-worker.<account>.workers.dev`）を控えます。

#### （任意）CORS を自分のサイトに絞る
`wrangler.toml` の `ALLOWED_ORIGIN` を GitHub Pages の Origin に変更します。
```toml
[vars]
ALLOWED_ORIGIN = "https://<your-name>.github.io"
```

#### 議事録の保存について
Worker は議事録を保存しません（BYOK の性質を維持するため、Cloudflare D1 は使いません）。
`POST /save` と `GET /minutes/:id` は常に `410 Gone` を返します。D1 用の `schema.sql` も削除済みです。
議事録を残したい場合は、設定画面で Notion 連携（`/notify`）を有効にしてください。

### 2. フロントエンドを公開
`frontend/` を GitHub Pages 等で配信します（`.github/workflows/pages.yml` が main への push で `frontend/` を公開します）。

**独自の Worker を使う場合**は、次の2か所を自分の Worker の URL（https のみ）に書き換えてください。片方だけだと接続できません。
- `frontend/app.js` の `DEFAULT_WORKER_URL`
- `frontend/index.html` の CSP メタタグの `connect-src`

ローカルで画面を確認する場合は `frontend/` を HTTP サーバーで配信してください（例: `npx http-server frontend -p 5173`）。
`file://` で直接開く方式は、CSP（`script-src 'self'`）の下では動作を保証しません。
なお本番 Worker の CORS は `ALLOWED_ORIGIN`（GitHub Pages の Origin）のみ許可しているため、ローカルの画面から本番 Worker への通信はブラウザに拒否されます。

### 3. 使い方
1. 公開した画面を開く。
2. **設定**に以下を入力して「設定を保存」：
   - OpenAI APIキー / Anthropic APIキー
   - （任意）Worker エンドポイント URL（空欄なら既定の Worker）
   - （任意）音声の言語
3. 音声ファイル（mp3/mp4/wav/m4a・25MB以下）を選択。
4. **「議事録を生成」**をクリック。
5. 生成された議事録を**コピー**または **Markdown ダウンロード**。

---

## 議事録の出力フォーマット
```
# 会議議事録
日時：[生成日時]

## 参加者
## 議題・話し合われた内容
## 決定事項
## アクションアイテム
## 次回会議

---
*この議事録はAIにより自動生成されました*
```

---

## 制約（MVP）
- ファイルサイズ上限：**25MB**（Whisper API の制限）
- 対応形式：**mp3 / mp4 / wav / m4a**
- 非対応：リアルタイム文字起こし／話者分離／Zoom・Teams・Meet 連携
- 認証：なし

---

## トラブルシューティング
| 症状 | 対処 |
|------|------|
| 「APIキーが無効です」 | キーの値・前後の空白・残高を確認 |
| 通信に失敗する / CORS エラー | Worker の URL と `ALLOWED_ORIGIN` を確認 |
| 「ファイルサイズが上限を超えています」 | 25MB 以下に分割・圧縮 |
| 「非対応のファイル形式です」 | mp3/mp4/wav/m4a に変換 |

---

## セキュリティ / プライバシー
- API キーはブラウザの localStorage に保存され、API 呼び出し時にヘッダーで Worker に渡されます。Worker はそれを外部 API 呼び出しに使うだけで保存しません。
- 保存済みの API キー・Token・Webhook URL は入力欄に書き戻さず、「設定済み（末尾4文字）」とだけ表示します。入力欄に値を入れて「設定を保存」したときだけ上書きします。
- 共有端末では使用後に「保存した設定を消去」を実行してください。

### フロントエンドの CSP
`frontend/index.html` の `<head>` 先頭に CSP メタタグを置いています。
- `default-src 'none'`、`script-src 'self'`、`style-src 'self'`（インラインのスクリプト・スタイル・イベントハンドラは使わない）
- `connect-src` は既定の Worker（`https://minutes-ai-worker.inverted-triangle-leef.workers.dev`）のみ
- Worker URL は https のみ受け付け、CSP で許可した Worker 以外は設定時にエラーにします
- Notion のページリンクは `https://www.notion.so/` で始まる URL のときだけリンクにします（それ以外は「保存しました」の表示のみ）

### SSRF 対策（`/notify` の Webhook）
`/notify` の Slack Webhook URL はユーザー指定のため、外部送信前に宛先を検証しています（`worker/src/lib/url-guard.js`）:
**fail-closed 方針**：判定できない入力はすべて拒否します。

- スキームは http/https のみ。認証情報付き URL（`https://user:pass@host/`）は拒否
- ホスト名 `localhost` / `ip6-localhost` / `*.localhost` / `*.local` / `*.internal` は名前だけで拒否（末尾ドット表記も正規化）
- 内部・予約帯域（`0/8`・`10/8`・`100.64/10`・`127/8`・`169.254/16`・`172.16/12`・`192.168/16`・TEST-NET・`fc00::/7`・`fe80::/10`・マルチキャスト等）宛を拒否
- 難読化 IP 表記（10進/16進/8進/inet_aton、IPv4-mapped/IPv4-compatible/6to4/NAT64 の IPv6 埋め込み v4）を正規化して判定
- **ホスト名は必ず DNS-over-HTTPS（`cloudflare-dns.com`）で解決し、全 A/AAAA レコードを検査します**。解決をスキップする経路はありません。次はすべて拒否：解決不能・A/AAAA が0件・解決結果を IP として解釈できない・A/AAAA の片方しか確定的に引けなかった（DoH の `Status` を見て SERVFAIL と「レコード無し」を区別し、部分的な解決結果は信用しない）
- リダイレクトは自動追従せず、**ホップごとに上記の検証をやり直します**（上限5ホップ）。`Location` 欠落のリダイレクトは失敗として扱います
- レスポンスサイズ上限（1MB）、DNS 解決・本体取得それぞれにタイムアウト（5s）を適用
- **残余リスク（これのみ）**: 検証時の DNS 解決結果と、`fetch` 実体が使う解決結果がずれうる（DNS リバインディング / TOCTOU）。Workers ランタイムでは検証済み IP への接続を強制できないため、この窓は塞げません。より厳格にしたい場合は Slack Webhook のホストを `hooks.slack.com` に固定する運用も可能です。

### レート制限
全エンドポイントにスライディングウィンドウ方式のレート制限を適用しています（`worker/src/lib/ratelimit.js`）。テナント（API キーのハッシュ）単位・IP 単位で個別に評価し、文字起こし・AI 呼び出し・外部送信など高コストな経路を優先的に制限します。超過時は `429`（`Retry-After` 付き）を返します。
- 既定は Durable Object 未バインド時のメモリ版フォールバック（isolate ローカル・ベストエフォート）。
- 本番で厳密なグローバル制限が必要な場合は `wrangler.toml` の `RATE_LIMITER` Durable Object バインドを有効化してください。

### 開発（テスト / 型チェック）
```bash
cd worker
npm install
npm test        # vitest（url-guard / ratelimit / worker E2E）
npm run typecheck  # tsc --checkJs
```
