CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  project_key TEXT NOT NULL, cwd TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'gateway'), created_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  owner_key TEXT NOT NULL, owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  project_key TEXT NOT NULL, cwd TEXT NOT NULL, prompt TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(thread_id), turn_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','starting','running','completed','failed','interrupted','unknown')),
  failure_phase TEXT CHECK(failure_phase IN ('thread_start','turn_start','execution')),
  error_code TEXT, version INTEGER NOT NULL DEFAULT 1, notification_message_id TEXT,
  waiting_approval INTEGER NOT NULL DEFAULT 0 CHECK(waiting_approval IN (0,1)),
  waiting_input INTEGER NOT NULL DEFAULT 0 CHECK(waiting_input IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(thread_id, turn_id)
);
CREATE INDEX tasks_queue ON tasks(status, created_at, task_id);
CREATE TABLE inbox (
  inbox_id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  method TEXT NOT NULL, thread_id TEXT, turn_id TEXT, payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL CHECK(state IN ('received','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX inbox_pending ON inbox(thread_id, turn_id, state);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox(inbox_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  state TEXT NOT NULL CHECK(state IN ('queued','processing','done','failed'))
);
CREATE TABLE rpc_operations (
  operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), method TEXT NOT NULL,
  connection_epoch TEXT NOT NULL, rpc_id_json TEXT CHECK(rpc_id_json IS NULL OR json_valid(rpc_id_json)),
  intent TEXT NOT NULL CHECK(json_valid(intent)),
  state TEXT NOT NULL CHECK(state IN ('intent','sent','known','unknown','not_sent','rejected')),
  result TEXT CHECK(result IS NULL OR json_valid(result)), error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(task_id), thread_id TEXT NOT NULL,
  turn_id TEXT, connection_epoch TEXT NOT NULL,
  rpc_id_json TEXT NOT NULL CHECK(json_valid(rpc_id_json) AND json_type(rpc_id_json) IN ('integer','text')),
  method TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','unsupported','expired','resolved')),
  decision TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(connection_epoch, rpc_id_json)
);
CREATE TABLE execution_locks (
  lock_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), created_at INTEGER NOT NULL
);
CREATE TABLE worker_lease (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token TEXT NOT NULL, pid INTEGER NOT NULL);
CREATE TABLE task_items (
  task_id TEXT NOT NULL REFERENCES tasks(task_id), item_id TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY(task_id, item_id)
);
CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  card_version INTEGER NOT NULL, message_id TEXT, operation TEXT CHECK(operation IN ('send','update')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sending','delivered','failed','unknown','superseded')),
  claim_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL,
  UNIQUE(task_id, card_version)
);
CREATE INDEX outbox_pending ON outbox(state, next_retry_at);
CREATE TABLE user_context (
  owner_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, task_id TEXT REFERENCES tasks(task_id), updated_at INTEGER NOT NULL
);
