# integration.md — エージェント向け統合手順

エージェントが minutes-ai を呼び出すための最小手順です。API の正式な契約は `../AGENTS.md` を参照してください。

## 前提
- デプロイ済みの Worker URL（`BASE_URL`）
- ユーザーから取得した OpenAI / Anthropic の API キー（クライアント側で保持し、リクエストごとにヘッダーで渡す）

## 手順

### 1. ヘルスチェック
```
GET {BASE_URL}/health
→ { "ok": true, "service": "minutes-ai-worker" }
```

### 2. 音声から議事録を生成（推奨：一括）
```
POST {BASE_URL}/minutes
Headers:
  x-openai-key: <OPENAI_API_KEY>
  x-anthropic-key: <ANTHROPIC_API_KEY>
Body (multipart/form-data):
  file: <audio file: mp3/mp4/wav/m4a, <=25MB>
  language: ja            # 任意
→ 200 { "transcript": "...", "minutes": "# 会議議事録 ..." }
```

### 3. 段階的に呼ぶ場合
```
POST {BASE_URL}/transcribe   (multipart: file, header x-openai-key)   → { transcript }
POST {BASE_URL}/generate     (json: { transcript }, header x-anthropic-key) → { minutes }
```

## curl 例
```bash
curl -X POST "$BASE_URL/minutes" \
  -H "x-openai-key: $OPENAI_API_KEY" \
  -H "x-anthropic-key: $ANTHROPIC_API_KEY" \
  -F "file=@meeting.m4a" \
  -F "language=ja"
```

## エラー処理
- レスポンスが 2xx 以外のとき、本文は `{ "error": "<日本語メッセージ>" }`。
- 401（キー不正）/ 429（レート制限・残高不足）/ 400（ファイル不正）/ 502（外部 API 接続失敗）を区別してユーザーに提示すること。

## 注意
- API キーをログや永続ストレージに残さないこと（BYOK モデルの前提）。
- 25MB を超えるファイル・非対応形式は送信前にクライアント側でも弾くこと。
