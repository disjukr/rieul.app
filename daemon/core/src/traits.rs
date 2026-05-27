use std::future::Future;
use std::pin::Pin;

use crate::rpc::{CreateNodeOp, DeleteMode, FsEntry, WriteFileMode};

pub type BoxFutureResult<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ServiceError>> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("permission denied")]
    PermissionDenied,
    #[error("not found")]
    NotFound,
    #[error("already exists")]
    AlreadyExists,
    #[error("not a directory")]
    NotDirectory,
    #[error("not a regular file")]
    NotFile,
    #[error("invalid path")]
    InvalidPath,
    #[error("unsupported operation")]
    Unsupported,
    #[error("operation failed: {0}")]
    OperationFailed(String),
}

pub trait FileService: Send + Sync {
    fn roots(&self) -> BoxFutureResult<'_, Vec<FsEntry>>;
    fn list_directory(&self, path: String) -> BoxFutureResult<'_, Vec<FsEntry>>;
    fn read_file(&self, path: String) -> BoxFutureResult<'_, Vec<u8>>;
    fn write_file(
        &self,
        path: String,
        mode: WriteFileMode,
        bytes: Vec<u8>,
    ) -> BoxFutureResult<'_, ()>;
    fn create_node(&self, op: CreateNodeOp) -> BoxFutureResult<'_, ()>;
    fn rename_path(&self, from: String, to: String) -> BoxFutureResult<'_, ()>;
    fn delete_path(&self, path: String, mode: DeleteMode) -> BoxFutureResult<'_, ()>;
}
