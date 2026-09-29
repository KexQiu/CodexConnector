-- The migrator rebuilds referenced tables with foreign_keys disabled, then validates
-- the entire graph before committing and restores enforcement even on rollback.
CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL, chat_id TEXT,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','projectless')),
  project_key TEXT, cwd TEXT NOT NULL,
  directory_device INTEGER, directory_inode INTEGER,
  thread_id TEXT UNIQUE REFERENCES threads(thread_id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((scope_kind='project' AND project_key IS NOT NULL) OR
        (scope_kind='projectless' AND project_key IS NULL AND chat_id IS NOT NULL AND directory_device IS NOT NULL AND directory_inode IS NOT NULL))
);
CREATE INDEX conversations_scope ON conversations(owner_key,chat_id,scope_kind,project_key,updated_at);

INSERT INTO conversations (conversation_id,owner_key,chat_id,scope_kind,project_key,cwd,thread_id,created_at,updated_at)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  th.owner_key,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks t LEFT JOIN task_destinations d ON d.task_id=t.task_id
    WHERE t.thread_id=th.thread_id AND (d.task_id IS NULL OR d.owner_key!=th.owner_key OR t.owner_key!=th.owner_key)
  ) AND (SELECT count(DISTINCT d.chat_id) FROM tasks t JOIN task_destinations d ON d.task_id=t.task_id WHERE t.thread_id=th.thread_id)=1
  THEN (SELECT min(d.chat_id) FROM tasks t JOIN task_destinations d ON d.task_id=t.task_id WHERE t.thread_id=th.thread_id)
  ELSE NULL END,
  'project',th.project_key,th.cwd,th.thread_id,th.created_at,th.created_at
FROM threads th;

CREATE TEMP TABLE conversation_task_backfill (task_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
INSERT INTO conversation_task_backfill
SELECT task_id,lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))
FROM tasks WHERE thread_id IS NULL;
INSERT INTO conversations (conversation_id,owner_key,chat_id,scope_kind,project_key,cwd,created_at,updated_at)
SELECT b.conversation_id,t.owner_key,d.chat_id,'project',t.project_key,t.cwd,t.created_at,t.updated_at
FROM conversation_task_backfill b JOIN tasks t ON t.task_id=b.task_id
LEFT JOIN task_destinations d ON d.task_id=t.task_id AND d.owner_key=t.owner_key;

CREATE TABLE threads_v11 (
  thread_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  project_key TEXT, cwd TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin='gateway'), created_at INTEGER NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id)
);
INSERT INTO threads_v11
SELECT th.*,c.conversation_id FROM threads th JOIN conversations c ON c.thread_id=th.thread_id;

CREATE TABLE tasks_v11 (
  task_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  owner_key TEXT NOT NULL, owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  project_key TEXT, cwd TEXT NOT NULL, prompt TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(thread_id), turn_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','starting','running','completed','failed','interrupted','unknown')),
  failure_phase TEXT CHECK(failure_phase IN ('thread_start','turn_start','execution')),
  error_code TEXT, version INTEGER NOT NULL DEFAULT 1, notification_message_id TEXT,
  waiting_approval INTEGER NOT NULL DEFAULT 0 CHECK(waiting_approval IN (0,1)),
  waiting_input INTEGER NOT NULL DEFAULT 0 CHECK(waiting_input IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  fingerprint_version INTEGER NOT NULL DEFAULT 1 CHECK(fingerprint_version IN (1,2)),
  UNIQUE(thread_id,turn_id)
);
INSERT INTO tasks_v11
SELECT t.*,coalesce(c.conversation_id,b.conversation_id),1
FROM tasks t LEFT JOIN conversations c ON c.thread_id=t.thread_id
LEFT JOIN conversation_task_backfill b ON b.task_id=t.task_id;
DROP TABLE tasks;
DROP TABLE threads;
ALTER TABLE threads_v11 RENAME TO threads;
ALTER TABLE tasks_v11 RENAME TO tasks;
CREATE INDEX tasks_queue ON tasks(status,created_at,task_id);
CREATE INDEX tasks_conversation ON tasks(conversation_id,created_at,task_id);
DROP TABLE conversation_task_backfill;

CREATE TABLE user_context_v11 (
  owner_key TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '',
  scope_kind TEXT NOT NULL DEFAULT 'project' CHECK(scope_kind IN ('project','projectless')),
  project_key TEXT, conversation_id TEXT REFERENCES conversations(conversation_id),
  task_id TEXT REFERENCES tasks(task_id), updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key,chat_id),
  CHECK((scope_kind='project' AND project_key IS NOT NULL) OR (scope_kind='projectless' AND project_key IS NULL))
);
INSERT INTO user_context_v11
SELECT u.owner_key,coalesce(c.chat_id,''),'project',u.project_key,c.conversation_id,u.task_id,u.updated_at
FROM user_context u LEFT JOIN tasks t ON t.task_id=u.task_id AND t.owner_key=u.owner_key
LEFT JOIN conversations c ON c.conversation_id=t.conversation_id AND c.project_key=u.project_key;
DROP TABLE user_context;
ALTER TABLE user_context_v11 RENAME TO user_context;

ALTER TABLE feishu_commands ADD COLUMN target_resolved INTEGER NOT NULL DEFAULT 0 CHECK(target_resolved IN (0,1));
ALTER TABLE feishu_commands ADD COLUMN target_scope_kind TEXT CHECK(target_scope_kind IN ('project','projectless'));
ALTER TABLE feishu_commands ADD COLUMN target_conversation_id TEXT REFERENCES conversations(conversation_id);
UPDATE feishu_commands SET target_resolved=1,target_scope_kind='project',
  target_conversation_id=(SELECT t.conversation_id FROM tasks t WHERE t.task_id=feishu_commands.target_task_id AND t.owner_key=feishu_commands.owner_key)
WHERE target_project_key IS NOT NULL OR target_task_id IS NOT NULL;


CREATE TABLE feishu_actions_v11 (
  nonce TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  task_id TEXT REFERENCES tasks(task_id), owner_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT, action TEXT NOT NULL CHECK(action IN ('refresh','select','approval','interrupt','new_topic','details','project','projects','cancel_draft','panel','sessions','result','copy_id','tasks','create_project','cancel_project','projectless_sessions','projectless_new')),
  expires_at INTEGER NOT NULL, approval_id TEXT REFERENCES approvals(approval_id), choice TEXT,
  project_key TEXT, draft_id TEXT REFERENCES feishu_drafts(draft_id), page INTEGER,
  CHECK(action IN ('project','projects','cancel_draft','panel','sessions','tasks','create_project','cancel_project','projectless_sessions','projectless_new') OR task_id IS NOT NULL),
  CHECK(action NOT IN ('project','sessions') OR project_key IS NOT NULL),
  CHECK(action != 'cancel_draft' OR draft_id IS NOT NULL),
  CHECK(action != 'panel' OR (choice IS NOT NULL AND choice IN ('refresh','new_topic','details'))),
  CHECK(action != 'tasks' OR (task_id IS NULL AND project_key IS NULL AND draft_id IS NULL AND choice IS NULL AND approval_id IS NULL AND page IS NOT NULL AND page BETWEEN 0 AND 499))
);
INSERT INTO feishu_actions_v11 SELECT * FROM feishu_actions;
DROP TABLE feishu_actions;
ALTER TABLE feishu_actions_v11 RENAME TO feishu_actions;
