CREATE TABLE feishu_actions_v9 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft','panel','sessions','result','copy_id','tasks')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft','panel','sessions','tasks') OR task_id IS NOT NULL),
  CHECK(action NOT IN ('project','sessions') OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL),
  CHECK(action != 'panel' OR (choice IS NOT NULL AND choice IN ('refresh','new_topic','details'))),
  CHECK(action != 'tasks' OR (task_id IS NULL AND project_key IS NULL AND draft_id IS NULL AND choice IS NULL AND approval_id IS NULL AND page IS NOT NULL AND page BETWEEN 0 AND 499))
);
INSERT INTO feishu_actions_v9 SELECT * FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v9 RENAME TO feishu_actions;
