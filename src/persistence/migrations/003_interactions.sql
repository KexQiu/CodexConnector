ALTER TABLE approvals ADD COLUMN payload TEXT CHECK(payload IS NULL OR json_valid(payload));
ALTER TABLE approvals ADD COLUMN answers TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(answers));
ALTER TABLE approvals ADD COLUMN response_state TEXT NOT NULL DEFAULT 'none' CHECK(response_state IN ('none','intent','sent','unknown'));
ALTER TABLE approvals ADD COLUMN error_code TEXT;
CREATE TABLE tool_observations (
  thread_id TEXT NOT NULL REFERENCES threads(thread_id), turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(thread_id, turn_id, item_id)
);
CREATE TABLE feishu_actions_v3 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT
);
INSERT INTO feishu_actions_v3 (nonce,outbox_id,task_id,owner_key,chat_id,message_id,action,expires_at)
  SELECT nonce,outbox_id,task_id,owner_key,chat_id,message_id,action,expires_at FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v3 RENAME TO feishu_actions;
CREATE TABLE task_controls (
  control_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  owner_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('steer','interrupt')),
  turn_id TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','sending','accepted','rejected','unknown')),
  error_code TEXT, created_at INTEGER NOT NULL
);
