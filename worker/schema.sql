-- Cloudflare D1 用スキーマ（任意機能：議事録の保存）
-- 適用例:
--   wrangler d1 execute minutes-ai-db --file=./schema.sql
CREATE TABLE IF NOT EXISTS minutes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_minutes_created_at ON minutes (created_at);
