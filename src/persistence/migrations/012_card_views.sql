-- Browsing cards have their own durable update lane, independent of tasks/panels.
ALTER TABLE outbox ADD COLUMN view_id TEXT REFERENCES outbox(outbox_id)
  CHECK(view_id IS NULL OR (task_id IS NULL AND panel_id IS NULL));
ALTER TABLE outbox ADD COLUMN view_parent_id TEXT REFERENCES outbox(outbox_id);
CREATE UNIQUE INDEX outbox_view_version ON outbox(view_id,card_version);
CREATE INDEX outbox_view_delivery ON outbox(view_id,state);
CREATE TABLE feishu_actions_v12 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft','panel','sessions','result','copy_id','tasks','create_project','cancel_project','projectless_sessions','projectless_new','back','quota')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft','panel','sessions','tasks','create_project','cancel_project','projectless_sessions','projectless_new','back','quota') OR task_id IS NOT NULL),
  CHECK(action NOT IN ('project','sessions') OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL),
  CHECK(action != 'panel' OR (choice IS NOT NULL AND choice IN ('refresh','new_topic','details'))),
  CHECK(action != 'tasks' OR (task_id IS NULL AND project_key IS NULL AND draft_id IS NULL AND choice IS NULL AND approval_id IS NULL AND page IS NOT NULL AND page BETWEEN 0 AND 499))
);
INSERT INTO feishu_actions_v12 SELECT * FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v12 RENAME TO feishu_actions;
