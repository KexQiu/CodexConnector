use codexconnector_core::{
    database::{migrate, open_database, validate_checksums, SCHEMA_VERSION},
    identity::{
        conversation_fingerprint, legacy_fingerprint, owner_key, request_key, OwnerIdentity,
    },
    Error, Result,
};
use rusqlite::{types::ValueRef, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HashCase {
    owner: OwnerIdentity,
    request: String,
    project: Option<String>,
    cwd: String,
    prompt: String,
    thread: Option<String>,
    conversation: String,
    owner_key: String,
    request_key: String,
    legacy_fingerprint: String,
    conversation_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    columns: Vec<String>,
    rows: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    hash_cases: Vec<HashCase>,
    tables: BTreeMap<String, Snapshot>,
}

fn verify_snapshot(database: &Connection, table: &str, expected: &Snapshot) -> Result<()> {
    if ![
        "tasks",
        "threads",
        "inbox",
        "rpc_operations",
        "outbox",
        "execution_locks",
        "task_destinations",
        "feishu_commands",
        "user_context",
    ]
    .contains(&table)
        || expected.columns.is_empty()
        || expected.columns.iter().any(|column| {
            column.is_empty()
                || !column
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    {
        return Err(Error::Invalid("不支持的兼容夹具字段"));
    }
    let columns = expected.columns.join(",");
    let mut query =
        database.prepare(&format!("SELECT {columns} FROM {table} ORDER BY {columns}"))?;
    let mut rows = query.query([])?;
    let mut actual = vec![];
    while let Some(row) = rows.next()? {
        let mut value = serde_json::Map::new();
        for (index, column) in expected.columns.iter().enumerate() {
            value.insert(
                column.clone(),
                match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(number) => json!(number),
                    ValueRef::Real(number) => json!(number),
                    ValueRef::Text(text) => {
                        json!(std::str::from_utf8(text)
                            .map_err(|_| Error::Invalid("数据编码无效"))?)
                    }
                    ValueRef::Blob(_) => return Err(Error::Invalid("夹具不支持二进制字段")),
                },
            );
        }
        actual.push(Value::Object(value));
    }
    if actual != expected.rows {
        return Err(Error::Invalid("迁移改变了既有持久记录"));
    }
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err(Error::Invalid(
            "用法：compatibility <独立测试数据库> <夹具 JSON>",
        ));
    }
    let expected: Expected = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    for case in &expected.hash_cases {
        let owner = owner_key(&case.owner)?;
        if owner != case.owner_key
            || request_key(&owner, &case.request)? != case.request_key
            || legacy_fingerprint(
                case.project.as_deref(),
                &case.cwd,
                &case.prompt,
                case.thread.as_deref(),
            )? != case.legacy_fingerprint
            || conversation_fingerprint(
                &case.conversation,
                case.project.as_deref(),
                &case.cwd,
                &case.prompt,
            )? != case.conversation_fingerprint
        {
            return Err(Error::Invalid("JavaScript/Rust 请求标识算法不兼容"));
        }
    }
    let mut database = open_database(Path::new(&args[1]))?;
    migrate(&mut database)?;
    validate_checksums(&database)?;
    for (table, snapshot) in &expected.tables {
        verify_snapshot(&database, table, snapshot)?;
    }
    println!(
        "{}",
        json!({"schemaVersion":SCHEMA_VERSION,"hashCases":expected.hash_cases.len(),"tables":expected.tables.len(),"compatible":true})
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
