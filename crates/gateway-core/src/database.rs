use crate::{identity::sha256, Error, Result};
use rusqlite::{backup::Backup, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const APPLICATION_ID: i64 = 0x43465847;
pub const SCHEMA_VERSION: i64 = 12;

macro_rules! migration {
    ($name:literal) => {
        include_str!(concat!("../../../src/persistence/migrations/", $name))
    };
}

pub const MIGRATIONS: [&str; SCHEMA_VERSION as usize] = [
    migration!("001_tasks.sql"),
    migration!("002_feishu.sql"),
    migration!("003_interactions.sql"),
    migration!("004_conversation_ui.sql"),
    migration!("005_context_panel.sql"),
    migration!("006_status_metrics.sql"),
    migration!("007_project_metrics.sql"),
    migration!("008_session_navigation.sql"),
    migration!("009_navigation_cards.sql"),
    migration!("010_remote_projects.sql"),
    migration!("011_projectless_sessions.sql"),
    migration!("012_card_views.sql"),
];

fn assert_private_parent(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::Invalid("数据库路径必须为绝对路径"));
    }
    let parent = fs::symlink_metadata(path.parent().ok_or(Error::Invalid("数据库路径无效"))?)?;
    // SAFETY: geteuid has no preconditions and only reads the process identity.
    if !parent.is_dir() || parent.mode() & 0o077 != 0 || parent.uid() != unsafe { libc::geteuid() }
    {
        return Err(Error::Invalid("数据库目录必须由当前用户独占"));
    }
    Ok(())
}

fn assert_private_file(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    if !info.is_file() || info.mode() & 0o077 != 0 || info.uid() != unsafe { libc::geteuid() } {
        return Err(Error::Invalid("数据库必须为当前用户的私有普通文件"));
    }
    Ok(())
}

fn canonical_database_path(path: &Path) -> Result<PathBuf> {
    assert_private_parent(path)?;
    // Resolve macOS ancestor aliases such as /var -> /private/var, never the
    // database filename itself: a final symlink remains forbidden.
    let parent = path.parent().ok_or(Error::Invalid("数据库路径无效"))?;
    let filename = path.file_name().ok_or(Error::Invalid("数据库路径无效"))?;
    Ok(fs::canonicalize(parent)?.join(filename))
}

fn create_private(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

pub fn open_database(path: &Path) -> Result<Connection> {
    let path = canonical_database_path(path)?;
    match create_private(&path) {
        Ok(file) => file.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    assert_private_file(&path)?;
    let database = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    database.busy_timeout(Duration::from_millis(250))?;
    let application_id: i64 = database.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let has_schema: bool =
        database.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema)", [], |r| {
            r.get(0)
        })?;
    if application_id != APPLICATION_ID && (application_id != 0 || has_schema) {
        return Err(Error::Invalid("拒绝打开非 CodexConnector 数据库"));
    }
    database.pragma_update(None, "application_id", APPLICATION_ID)?;
    database.pragma_update(None, "journal_mode", "WAL")?;
    database.pragma_update(None, "synchronous", "FULL")?;
    database.pragma_update(None, "foreign_keys", "ON")?;
    let journal: String = database.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    let synchronous: i64 = database.pragma_query_value(None, "synchronous", |r| r.get(0))?;
    let foreign_keys: i64 = database.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    if journal != "wal" || synchronous != 2 || foreign_keys != 1 {
        return Err(Error::Invalid("数据库持久化设置未生效"));
    }
    Ok(database)
}

pub fn validate_checksums(database: &Connection) -> Result<()> {
    let mut query = database.prepare("SELECT checksum FROM schema_migrations WHERE version=?")?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let checksum: Option<String> = query
            .query_row([(index + 1) as i64], |r| r.get(0))
            .optional()?;
        if checksum.as_deref() != Some(sha256(sql).as_str()) {
            return Err(Error::Invalid("数据库迁移校验和不匹配"));
        }
    }
    Ok(())
}

/// Applies the same SQL bytes and checksums as the Node gateway in one IMMEDIATE transaction.
pub fn migrate(database: &mut Connection) -> Result<()> {
    if !database.is_autocommit() {
        return Err(Error::Invalid("迁移必须使用独立事务"));
    }
    let foreign_keys: i64 = database.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
    database.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| {
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = transaction.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if !(0..=SCHEMA_VERSION).contains(&version) {
            return Err(Error::Invalid("不支持此数据库版本"));
        }
        if version == 0
            && transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                [], |r| r.get::<_, bool>(0),
            )?
        {
            return Err(Error::Invalid("拒绝迁移无版本的既有数据"));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate() {
            let next = (index + 1) as i64;
            let checksum = sha256(sql);
            if next <= version {
                let stored: Option<String> = transaction
                    .query_row(
                        "SELECT checksum FROM schema_migrations WHERE version=?",
                        [next],
                        |r| r.get(0),
                    )
                    .optional()?;
                if stored.as_deref() != Some(checksum.as_str()) {
                    return Err(Error::Invalid("数据库迁移校验和不匹配"));
                }
                continue;
            }
            if next > 1
                && transaction.query_row("SELECT EXISTS(SELECT 1 FROM worker_lease)", [], |r| {
                    r.get::<_, bool>(0)
                })?
            {
                return Err(Error::Invalid("迁移前必须停止已有任务 worker"));
            }
            if next > 2
                && transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM feishu_runtime_lease)",
                    [],
                    |r| r.get::<_, bool>(0),
                )?
            {
                return Err(Error::Invalid("迁移前必须停止已有 Gateway"));
            }
            transaction.execute_batch(sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations VALUES (?,?)",
                (next, checksum),
            )?;
            transaction.pragma_update(None, "user_version", next)?;
        }
        validate_columns(&transaction)?;
        if transaction
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
        {
            return Err(Error::Invalid("数据库外键检查失败"));
        }
        transaction.commit()?;
        Ok(())
    })();
    // The transaction is dropped/rolled back before restoring FK enforcement.
    database.pragma_update(None, "foreign_keys", foreign_keys)?;
    result
}

fn validate_columns(database: &Connection) -> Result<()> {
    for (table, columns) in [
        ("tasks", "task_id,request_key,status,thread_id,turn_id,version,notification_message_id,conversation_id,fingerprint_version"),
        ("threads", "thread_id,owner_key,cwd,conversation_id"),
        ("conversations", "conversation_id,owner_key,chat_id,scope_kind,project_key,cwd,thread_id"),
        ("inbox", "event_key,state,attempts,payload"),
        ("commands", "command_id,inbox_id,task_id,state"),
        ("rpc_operations", "operation_id,rpc_id_json,connection_epoch,intent,state"),
        ("approvals", "approval_id,connection_epoch,rpc_id_json,state,payload,answers,response_state"),
        ("execution_locks", "lock_key,task_id"),
        ("outbox", "logical_key,card_version,state,claim_token,lease_until,panel_id,view_id,view_parent_id"),
        ("feishu_panels", "panel_id,owner_key,chat_id,message_id,message_created_at,version,snapshot_hash,refresh_requested,next_refresh_at,core_hash,last_rendered_at"),
        ("user_context", "owner_key,chat_id,scope_kind,project_key,conversation_id,task_id"),
        ("session_metrics", "thread_id,payload"),
        ("account_metrics", "owner_key,payload"),
        ("project_metrics", "owner_key,project_key,payload"),
        ("worker_lease", "singleton,token,pid"),
        ("task_items", "task_id,item_id,text"),
        ("task_destinations", "task_id,owner_key,chat_id"),
        ("feishu_commands", "command_id,business_key,state,payload,target_task_id,target_project_key,target_resolved,target_scope_kind,target_conversation_id"),
        ("feishu_actions", "nonce,outbox_id,owner_key,message_id,project_key,draft_id,page"),
        ("feishu_drafts", "draft_id,owner_key,chat_id,prompt,state,expires_at"),
        ("feishu_runtime_lease", "singleton,token,pid"),
        ("tool_observations", "thread_id,turn_id,item_id,payload"),
        ("task_controls", "control_id,task_id,kind,turn_id,state"),
        ("remote_projects", "request_id,owner_key,chat_id,project_key,root,state,device,inode"),
        ("remote_project_prompts", "owner_key,chat_id,token,expires_at"),
    ] {
        database.prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))?;
    }
    Ok(())
}

/// Online consistent snapshot, never a filesystem copy of the live WAL database.
pub fn backup(database: &Connection, destination: &Path) -> Result<()> {
    let destination = canonical_database_path(destination)?;
    let created = create_private(&destination)?;
    let outcome = (|| {
        let mut target = Connection::open_with_flags(
            &destination,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        target.busy_timeout(Duration::from_millis(250))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let backup = Backup::new(database, &mut target)?;
        loop {
            match backup.step(100)? {
                rusqlite::backup::StepResult::Done => break,
                _ if Instant::now() >= deadline => return Err(Error::Invalid("数据库备份超时")),
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        drop(backup);
        let integrity: String = target.pragma_query_value(None, "quick_check", |r| r.get(0))?;
        if integrity != "ok" {
            return Err(Error::Invalid("数据库备份完整性检查失败"));
        }
        drop(target);
        created.sync_all()?;
        File::open(destination.parent().ok_or(Error::Invalid("备份路径无效"))?)?.sync_all()?;
        Ok(())
    })();
    if outcome.is_err() {
        let expected = created.metadata()?;
        if let Ok(actual) = fs::symlink_metadata(&destination) {
            if actual.dev() == expected.dev() && actual.ino() == expected.ino() {
                fs::remove_file(&destination)?;
            }
        }
    }
    outcome
}
