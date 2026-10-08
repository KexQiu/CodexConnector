pub mod database;
pub mod identity;
pub mod model;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("数据库操作失败")]
    Database(#[from] rusqlite::Error),
    #[error("本机文件操作失败")]
    Io(#[from] std::io::Error),
    #[error("持久化数据结构不兼容")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
