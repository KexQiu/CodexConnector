CREATE TABLE feishu_panels (
  panel_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, message_created_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0, snapshot_hash TEXT,
  refresh_requested INTEGER NOT NULL DEFAULT 1,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_key, chat_id)
);
ALTER TABLE outbox ADD COLUMN panel_id TEXT REFERENCES feishu_panels(panel_id) CHECK(panel_id IS NULL OR task_id IS NULL);
CREATE UNIQUE INDEX outbox_panel_version ON outbox(panel_id, card_version);
CREATE TABLE feishu_actions_v5 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft','panel')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft','panel') OR task_id IS NOT NULL),
  CHECK(action != 'project' OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL),
  CHECK(action != 'panel' OR (choice IS NOT NULL AND choice IN ('refresh','new_topic','details')))
);
INSERT INTO feishu_actions_v5 SELECT * FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v5 RENAME TO feishu_actions;
