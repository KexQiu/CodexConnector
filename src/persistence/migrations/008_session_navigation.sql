CREATE TABLE feishu_actions_v8 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft','panel','sessions','result','copy_id')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft','panel','sessions') OR task_id IS NOT NULL),
  CHECK(action NOT IN ('project','sessions') OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL),
  CHECK(action != 'panel' OR (choice IS NOT NULL AND choice IN ('refresh','new_topic','details')))
);
INSERT INTO feishu_actions_v8 SELECT * FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v8 RENAME TO feishu_actions;
