CREATE TABLE task_destinations (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL
);
CREATE TABLE feishu_commands (
  command_id TEXT PRIMARY KEY, business_key TEXT NOT NULL UNIQUE, inbox_id TEXT NOT NULL REFERENCES inbox(inbox_id),
  owner_key TEXT NOT NULL, chat_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL CHECK(state IN ('received','processed','failed')),
  task_id TEXT REFERENCES tasks(task_id), attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE outbox_v2 (
  outbox_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, task_id TEXT REFERENCES tasks(task_id),
  card_version INTEGER NOT NULL, message_id TEXT, operation TEXT CHECK(operation IN ('send','update')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sending','delivered','failed','unknown','superseded')),
  claim_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL,
  owner_key TEXT, chat_id TEXT, wire_content TEXT, sent_at INTEGER, reconcile_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_id, card_version)
);
INSERT INTO outbox_v2 (outbox_id,logical_key,task_id,card_version,message_id,operation,payload,state,claim_token,lease_until,attempts,next_retry_at,error_code,created_at)
  SELECT outbox_id,logical_key,task_id,card_version,message_id,operation,payload,state,claim_token,lease_until,attempts,next_retry_at,error_code,created_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_v2 RENAME TO outbox;
CREATE INDEX outbox_pending ON outbox(state, next_retry_at);
CREATE TABLE feishu_actions (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE feishu_runtime_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
