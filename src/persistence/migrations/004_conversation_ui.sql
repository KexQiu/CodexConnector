CREATE TABLE feishu_drafts (
  draft_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','submitted','cancelled')),
  task_id TEXT REFERENCES tasks(task_id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
ALTER TABLE feishu_commands ADD COLUMN target_task_id TEXT REFERENCES tasks(task_id);
ALTER TABLE feishu_commands ADD COLUMN target_project_key TEXT;
CREATE TABLE feishu_actions_v4 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft') OR task_id IS NOT NULL),
  CHECK(action != 'project' OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL)
);
INSERT INTO feishu_actions_v4 (nonce,outbox_id,task_id,owner_key,chat_id,message_id,action,expires_at,approval_id,choice)
  SELECT nonce,outbox_id,task_id,owner_key,chat_id,message_id,action,expires_at,approval_id,choice FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v4 RENAME TO feishu_actions;
