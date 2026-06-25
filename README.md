# minutes-ai 📝

BYOK（Bring Your Own Key）モデルの **AI議事録自動生成ツール**。
音声ファイルをアップロードするだけで、文字起こし → 構造化された議事録（Markdown）を生成します。

- **Frontend**：静的HTML 1ファイル（GitHub Pages）
- **Backend**：Cloudflare Workers
- **文字起こし**：OpenAI Whisper API（ユーザーのキー）
- **議事録生成**：Anthropic Claude API（ユーザーのキー）
- **ストレージ**：Cloudflare D1（任意）

APIキーは**ブラウザの localStorage にのみ保存**され、サーバーには保存されません。

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
│   └── index.html         # 単一ファイルのWebアプリ
└── worker/
    ├── src/index.js       # Cloudflare Workers 本体
    ├── schema.sql         # D1 スキーマ（任意機能）
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

#### （任意）議事録の保存に D1 を使う
```bash
wrangler d1 create minutes-ai-db
# 出力された database_id を wrangler.toml の [[d1_databases]] に貼り付けてコメント解除
wrangler d1 execute minutes-ai-db --file=./schema.sql
wrangler deploy
```
D1 を設定しない場合でも、文字起こし・議事録生成は問題なく動作します（保存機能のみ無効）。

### 2. フロントエンドを公開
`frontend/index.html` を GitHub Pages 等で配信します。
```bash
# 例：リポジトリの設定で Pages を有効化し、frontend/ を公開ディレクトリに指定
```
ローカルで試す場合はファイルをブラウザで直接開くだけでも動作します。

### 3. 使い方
1. 公開した画面を開く。
2. **設定**に以下を入力して「設定を保存」：
   - Worker エンドポイント URL（手順1の URL）
   - OpenAI APIキー / Anthropic APIキー
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
- 共有端末では使用後に「保存した設定を消去」を実行してください。
