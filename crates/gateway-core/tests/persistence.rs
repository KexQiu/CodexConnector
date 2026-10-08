use codexconnector_core::{
    database::{backup, migrate, open_database, validate_checksums, MIGRATIONS, SCHEMA_VERSION},
    identity::sha256,
    model::TaskStatus,
};
use rusqlite::Connection;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

fn fixture() -> (tempfile::TempDir, Connection) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = open_database(&directory.path().join("gateway.sqlite")).unwrap();
    (directory, database)
}

fn old_schema(database: &Connection, version: usize) {
    for (index, sql) in MIGRATIONS.iter().take(version).enumerate() {
        database.execute_batch(sql).unwrap();
        database
            .execute(
                "INSERT INTO schema_migrations VALUES (?,?)",
                ((index + 1) as i64, sha256(sql)),
            )
            .unwrap();
        database
            .pragma_update(None, "user_version", (index + 1) as i64)
            .unwrap();
    }
}

#[test]
fn full_schema_is_compatible_and_idempotent() {
    let (_directory, mut database) = fixture();
    migrate(&mut database).unwrap();
    migrate(&mut database).unwrap();
    validate_checksums(&database).unwrap();
    assert_eq!(
        database
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(
        database
            .pragma_query_value(None, "quick_check", |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn checksum_failure_rolls_back_and_restores_foreign_keys() {
    let (_directory, mut database) = fixture();
    old_schema(&database, 10);
    database
        .execute(
            "UPDATE schema_migrations SET checksum='tampered' WHERE version=4",
            [],
        )
        .unwrap();
    assert!(migrate(&mut database).is_err());
    assert_eq!(
        database
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    assert_eq!(
        database
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='conversations'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn refuses_leased_schema_without_mutating_data() {
    let (_directory, mut database) = fixture();
    old_schema(&database, 10);
    database
        .execute("INSERT INTO worker_lease VALUES (1,'existing',123)", [])
        .unwrap();
    assert!(migrate(&mut database).is_err());
    database.execute("DELETE FROM worker_lease", []).unwrap();
    database
        .execute(
            "INSERT INTO feishu_runtime_lease VALUES (1,'existing',123)",
            [],
        )
        .unwrap();
    assert!(migrate(&mut database).is_err());
    assert_eq!(
        database
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
}

#[test]
fn refuses_unversioned_newer_and_drifted_schema() {
    let (_directory, mut database) = fixture();
    database
        .execute("CREATE TABLE external (value TEXT)", [])
        .unwrap();
    assert!(migrate(&mut database).is_err());
    database.execute("DROP TABLE external", []).unwrap();
    database.pragma_update(None, "user_version", 13).unwrap();
    assert!(migrate(&mut database).is_err());
    database.pragma_update(None, "user_version", 0).unwrap();
    migrate(&mut database).unwrap();
    database
        .execute("ALTER TABLE task_items RENAME COLUMN text TO drifted", [])
        .unwrap();
    assert!(migrate(&mut database).is_err());
}

#[test]
fn backup_preserves_committed_wal_and_never_overwrites() {
    let (directory, mut database) = fixture();
    migrate(&mut database).unwrap();
    database
        .execute("INSERT INTO account_metrics VALUES ('owner','{}')", [])
        .unwrap();
    let destination = directory.path().join("backup.sqlite");
    backup(&database, &destination).unwrap();
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(backup(&database, &destination).is_err());
    let restored = open_database(&destination).unwrap();
    assert_eq!(
        restored
            .query_row(
                "SELECT payload FROM account_metrics WHERE owner_key='owner'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "{}"
    );
    validate_checksums(&restored).unwrap();
}

#[test]
fn blocks_symlinks_shared_permissions_and_foreign_database() {
    assert!(open_database(Path::new("relative.sqlite")).is_err());
    let (directory, database) = fixture();
    drop(database);
    let original = directory.path().join("gateway.sqlite");
    let link = directory.path().join("linked.sqlite");
    std::os::unix::fs::symlink(&original, &link).unwrap();
    assert!(open_database(&link).is_err());
    fs::set_permissions(&original, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(open_database(&original).is_err());
    let foreign = directory.path().join("foreign.sqlite");
    let connection = Connection::open(&foreign).unwrap();
    connection
        .execute("CREATE TABLE codex_private_history (value TEXT)", [])
        .unwrap();
    drop(connection);
    fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(open_database(&foreign).is_err());
}

#[test]
fn unknown_holds_locks_and_terminal_states_never_reenter_execution() {
    use TaskStatus::*;
    assert!(Unknown.holds_execution_lock());
    assert!(!Unknown.is_terminal());
    assert!(!Unknown.can_transition(Queued));
    assert!(Unknown.can_transition(Completed));
    for terminal in [Completed, Failed, Interrupted] {
        assert!(terminal.is_terminal());
        assert!(!terminal.holds_execution_lock());
        for next in [Queued, Starting, Running, Unknown] {
            assert!(!terminal.can_transition(next));
        }
    }
    assert!(Queued.can_transition(Interrupted));
    assert!(Starting.can_transition(Completed));
}
