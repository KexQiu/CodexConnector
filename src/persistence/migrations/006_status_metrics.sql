CREATE TABLE session_metrics (
  thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE account_metrics (
  owner_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
ALTER TABLE feishu_panels ADD COLUMN core_hash TEXT;
ALTER TABLE feishu_panels ADD COLUMN last_rendered_at INTEGER NOT NULL DEFAULT 0;
