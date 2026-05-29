use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use wgo_daemon_core::rpc::{
    CreateNodeOp, CreateNodeSpec, DeleteMode, FsEntry, FsEntryKind, WriteFileMode,
};
use wgo_daemon_core::traits::{BoxFutureResult, FileService, ServiceError};

#[derive(Debug, Default, Clone)]
pub struct MacFileService;

impl FileService for MacFileService {
    fn roots(&self) -> BoxFutureResult<'_, Vec<FsEntry>> {
        Box::pin(async move { list_directory_entries("/") })
    }

    fn list_directory(&self, path: String) -> BoxFutureResult<'_, Vec<FsEntry>> {
        Box::pin(async move { list_directory_entries(&path) })
    }

    fn read_file(&self, path: String) -> BoxFutureResult<'_, Vec<u8>> {
        Box::pin(async move {
            let metadata = fs::symlink_metadata(&path).map_err(map_io_error)?;
            if !metadata.is_file() {
                return Err(ServiceError::NotFile);
            }
            fs::read(path).map_err(map_io_error)
        })
    }

    fn write_file(
        &self,
        path: String,
        mode: WriteFileMode,
        bytes: Vec<u8>,
    ) -> BoxFutureResult<'_, ()> {
        Box::pin(async move {
            ensure_parent_directory_exists(Path::new(&path))?;
            match mode {
                WriteFileMode::CreateNew => OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
                    .map_err(map_io_error),
                WriteFileMode::CreateOrReplace => {
                    if let Ok(metadata) = fs::symlink_metadata(&path) {
                        if !metadata.is_file() {
                            return Err(ServiceError::NotFile);
                        }
                    }
                    fs::write(path, bytes).map_err(map_io_error)
                }
            }
        })
    }

    fn create_node(&self, op: CreateNodeOp) -> BoxFutureResult<'_, ()> {
        Box::pin(async move {
            let path = PathBuf::from(&op.path);
            match op.spec {
                CreateNodeSpec::Directory => create_directory_node(&path),
                CreateNodeSpec::File => {
                    create_parent_directories(&path)?;
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(path)
                        .map(|_| ())
                        .map_err(map_io_error)
                }
                CreateNodeSpec::Symlink { target } => {
                    create_parent_directories(&path)?;
                    create_symlink_node(&target, &path)
                }
                CreateNodeSpec::Hardlink { target } => {
                    create_parent_directories(&path)?;
                    let target_metadata = fs::symlink_metadata(&target).map_err(map_io_error)?;
                    if !target_metadata.is_file() {
                        return Err(ServiceError::NotFile);
                    }
                    fs::hard_link(target, path).map_err(map_io_error)
                }
            }
        })
    }

    fn rename_path(&self, from: String, to: String) -> BoxFutureResult<'_, ()> {
        Box::pin(async move { fs::rename(from, to).map_err(map_io_error) })
    }

    fn delete_path(&self, path: String, mode: DeleteMode) -> BoxFutureResult<'_, ()> {
        Box::pin(async move {
            match mode {
                DeleteMode::Trash => trash::delete(path)
                    .map_err(|err| ServiceError::OperationFailed(err.to_string())),
                DeleteMode::Permanent => delete_permanently(Path::new(&path)),
            }
        })
    }
}

fn to_fs_entry(path: PathBuf, metadata: fs::Metadata) -> FsEntry {
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        FsEntryKind::Symlink
    } else if metadata.is_dir() {
        FsEntryKind::Directory
    } else if metadata.is_file() {
        FsEntryKind::File
    } else {
        FsEntryKind::Other
    };
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    FsEntry {
        name: fs_entry_name(&path),
        path: path.to_string_lossy().to_string(),
        kind,
        size: metadata.is_file().then_some(metadata.len()),
        modified_at_ms,
        readonly: metadata.permissions().readonly(),
    }
}

fn fallback_fs_entry(path: PathBuf) -> FsEntry {
    FsEntry {
        name: fs_entry_name(&path),
        path: path.to_string_lossy().to_string(),
        kind: FsEntryKind::Other,
        size: None,
        modified_at_ms: None,
        readonly: true,
    }
}

fn fs_entry_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn list_directory_entries(path: &str) -> Result<Vec<FsEntry>, ServiceError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(map_io_error)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        entries.push(match fs::symlink_metadata(&path) {
            Ok(metadata) => to_fs_entry(path, metadata),
            Err(_) => fallback_fs_entry(path),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

fn create_directory_node(path: &Path) -> Result<(), ServiceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(ServiceError::AlreadyExists),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(map_io_error)
        }
        Err(err) => Err(map_io_error(err)),
    }
}

fn create_parent_directories(path: &Path) -> Result<(), ServiceError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(map_io_error)?;
    }
    Ok(())
}

fn ensure_parent_directory_exists(path: &Path) -> Result<(), ServiceError> {
    let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return Ok(());
    };
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(ServiceError::NotDirectory),
        Err(err) => Err(map_io_error(err)),
    }
}

fn delete_permanently(path: &Path) -> Result<(), ServiceError> {
    let metadata = fs::symlink_metadata(path).map_err(map_io_error)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(map_io_error)
    } else {
        fs::remove_file(path).map_err(map_io_error)
    }
}

fn create_symlink_node(target: &str, path: &Path) -> Result<(), ServiceError> {
    std::os::unix::fs::symlink(target, path).map_err(map_io_error)
}

fn map_io_error(err: std::io::Error) -> ServiceError {
    match err.kind() {
        std::io::ErrorKind::NotFound => ServiceError::NotFound,
        std::io::ErrorKind::PermissionDenied => ServiceError::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => ServiceError::AlreadyExists,
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
            ServiceError::InvalidPath
        }
        std::io::ErrorKind::NotADirectory => ServiceError::NotDirectory,
        std::io::ErrorKind::IsADirectory => ServiceError::NotFile,
        _ => ServiceError::OperationFailed(err.to_string()),
    }
}
