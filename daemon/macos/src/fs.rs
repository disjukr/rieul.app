use std::fs::{self, FileTimes, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use rieul_daemon_core::rpc::{
    CreateNodeOp, CreateNodeSpec, DeleteMode, FsEntry, FsEntryKind, MAX_U53, ReadFileReq,
    TrashItem, WriteFileChunk, WriteFileMode, WriteFileResult, WriteFileStart,
};
use rieul_daemon_core::traits::{BoxFutureResult, FileService, ServiceError, WriteFileChunkSource};

#[derive(Debug, Default, Clone)]
pub struct MacFileService;

impl FileService for MacFileService {
    fn home_directory(&self) -> BoxFutureResult<'_, String> {
        Box::pin(async { Ok(active_user_home()?.home.to_string_lossy().into_owned()) })
    }
    fn roots(&self) -> BoxFutureResult<'_, Vec<FsEntry>> {
        Box::pin(async move { list_directory_entries("/") })
    }

    fn list_directory(&self, path: String) -> BoxFutureResult<'_, Vec<FsEntry>> {
        Box::pin(async move { list_directory_entries(&path) })
    }

    fn read_file(&self, request: ReadFileReq) -> BoxFutureResult<'_, Vec<u8>> {
        Box::pin(async move {
            let metadata = fs::symlink_metadata(&request.path).map_err(map_io_error)?;
            if !metadata.is_file() {
                return Err(ServiceError::NotFile);
            }
            let mut file = fs::File::open(&request.path).map_err(map_io_error)?;
            file.seek(SeekFrom::Start(request.offset.unwrap_or(0)))
                .map_err(map_io_error)?;
            let mut bytes = Vec::new();
            match request.length {
                Some(length) => {
                    file.take(length)
                        .read_to_end(&mut bytes)
                        .map_err(map_io_error)?;
                }
                None => {
                    file.read_to_end(&mut bytes).map_err(map_io_error)?;
                }
            }
            Ok(bytes)
        })
    }

    fn write_file<'a>(
        &'a self,
        start: WriteFileStart,
        mut chunks: Box<dyn WriteFileChunkSource + 'a>,
    ) -> BoxFutureResult<'a, WriteFileResult> {
        Box::pin(async move {
            let path = PathBuf::from(&start.path);
            ensure_parent_directory_exists(&path)?;
            let bytes_written = write_file_chunks(&path, start.mode, chunks.as_mut()).await?;
            set_modified_time_best_effort(&path, start.modified_at_ms);
            let metadata = fs::metadata(&path).map_err(map_io_error)?;
            let result_size = metadata.len();
            if result_size > MAX_U53 {
                return Err(ServiceError::OperationFailed(
                    "result file size exceeds u53".to_string(),
                ));
            }
            if start
                .expected_result_size
                .is_some_and(|expected| expected != result_size)
            {
                return Err(ServiceError::OperationFailed(
                    "result file size does not match expectedResultSize".to_string(),
                ));
            }
            Ok(WriteFileResult {
                bytes_written,
                result_size,
                modified_at_ms: metadata_modified_at_ms(&metadata),
            })
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

    fn trash_items(&self) -> BoxFutureResult<'_, Vec<TrashItem>> {
        Box::pin(async move {
            let user = active_user_home()?;
            let items = list_user_trash(&user).await?;
            if active_user_home()? != user {
                return Err(ServiceError::PermissionDenied);
            }
            Ok(items)
        })
    }

    fn restore_trash_item(&self, _item_id: String) -> BoxFutureResult<'_, ()> {
        Box::pin(async move { Err(ServiceError::Unsupported) })
    }

    fn purge_trash_item(&self, _item_id: String) -> BoxFutureResult<'_, ()> {
        Box::pin(async move { Err(ServiceError::Unsupported) })
    }
}

#[derive(Debug, PartialEq, Eq)]
struct UserHome {
    uid: u32,
    home: PathBuf,
}

fn active_user_home() -> Result<UserHome, ServiceError> {
    use std::os::unix::fs::MetadataExt;
    let effective = unsafe { libc::geteuid() };
    let uid = if effective == 0 {
        fs::metadata("/dev/console").map_err(map_io_error)?.uid()
    } else {
        effective
    };
    if uid < 500 || uid == u32::MAX {
        return Err(ServiceError::OperationFailed(
            "No logged-in user home is available".into(),
        ));
    }
    let mut record = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0u8; 128 * 1024];
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut record,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || record.pw_dir.is_null() {
        return Err(ServiceError::OperationFailed(
            "Cannot resolve the logged-in user's home".into(),
        ));
    }
    use std::os::unix::ffi::OsStringExt;
    let home = PathBuf::from(std::ffi::OsString::from_vec(
        unsafe { std::ffi::CStr::from_ptr(record.pw_dir) }
            .to_bytes()
            .to_vec(),
    ));
    validate_user_home(uid, home)
}

fn validate_user_home(uid: u32, home: PathBuf) -> Result<UserHome, ServiceError> {
    use std::os::unix::fs::MetadataExt;
    if uid < 500 || !home.is_absolute() || home == Path::new("/") || home == Path::new("/var/root")
    {
        return Err(ServiceError::PermissionDenied);
    }
    let metadata = fs::symlink_metadata(&home).map_err(map_io_error)?;
    if !metadata.is_dir() || metadata.uid() != uid {
        return Err(ServiceError::PermissionDenied);
    }
    Ok(UserHome { uid, home })
}

async fn list_user_trash(user: &UserHome) -> Result<Vec<TrashItem>, ServiceError> {
    use std::os::unix::fs::MetadataExt;
    use tokio::io::AsyncReadExt;
    let path = user.home.join(".Trash");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(map_io_error(error)),
        Ok(metadata) if !metadata.is_dir() || metadata.uid() != user.uid => {
            return Err(ServiceError::PermissionDenied);
        }
        Ok(_) => (),
    }
    // Enumerate with the user's credentials, never root's filesystem access.
    // No shell, no permission prompts, no symlink traversal, and bounded output.
    let mut command = if unsafe { libc::geteuid() } == 0 {
        let mut command = tokio::process::Command::new("/usr/bin/sudo");
        command.args(["-n", "-H", "-u", &format!("#{}", user.uid), "/usr/bin/find"]);
        command
    } else {
        if unsafe { libc::geteuid() } != user.uid {
            return Err(ServiceError::PermissionDenied);
        }
        tokio::process::Command::new("/usr/bin/find")
    };
    let mut child = command
        .arg("-P")
        .arg(&path)
        .args(["-mindepth", "1", "-maxdepth", "1", "-print0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(map_io_error)?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        child.stdout.take().unwrap().take(1024 * 1024 + 1).read_to_end(&mut output).await.map_err(map_io_error)?;
        if output.len() > 1024 * 1024 { return Err(ServiceError::OperationFailed("Trash listing exceeds limit".into())); }
        if !child.wait().await.map_err(map_io_error)?.success() {
            return Err(ServiceError::OperationFailed("macOS denied access to the logged-in user's Trash. OS privacy permission may be required.".into()));
        }
        trash_rows(&path, &output)
    }).await.map_err(|_| ServiceError::OperationFailed("Trash listing timed out".into()))?;
    result
}

fn trash_rows(path: &Path, output: &[u8]) -> Result<Vec<TrashItem>, ServiceError> {
    use std::os::unix::ffi::OsStrExt;
    let mut rows = Vec::new();
    for bytes in output.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let entry = Path::new(std::ffi::OsStr::from_bytes(bytes));
        if entry.parent() != Some(path) {
            return Err(ServiceError::InvalidPath);
        }
        let name = entry
            .file_name()
            .ok_or(ServiceError::InvalidPath)?
            .to_string_lossy()
            .into_owned();
        if name == ".DS_Store" {
            continue;
        }
        rows.push(TrashItem {
            id: entry.to_string_lossy().into_owned(),
            name,
            original_parent: String::new(),
            deleted_at_ms: None,
            size: None,
            read_only: Some(true),
        });
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}

async fn write_file_chunks(
    path: &Path,
    mode: WriteFileMode,
    chunks: &mut dyn WriteFileChunkSource,
) -> Result<u64, ServiceError> {
    let mut bytes_written = 0u64;
    match mode {
        WriteFileMode::Create => {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(map_io_error)?;
            write_seekable_chunks(&mut file, chunks, false, &mut bytes_written).await?;
        }
        WriteFileMode::Replace => {
            if let Ok(metadata) = fs::symlink_metadata(path) {
                if !metadata.is_file() {
                    return Err(ServiceError::NotFile);
                }
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(path)
                .map_err(map_io_error)?;
            write_seekable_chunks(&mut file, chunks, false, &mut bytes_written).await?;
        }
        WriteFileMode::Append => {
            ensure_regular_file_exists(path)?;
            let mut file = OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(map_io_error)?;
            while let Some(chunk) = chunks.next_chunk().await? {
                if chunk.offset.is_some() {
                    return Err(ServiceError::InvalidPath);
                }
                file.write_all(&chunk.bytes).map_err(map_io_error)?;
                bytes_written = add_chunk_len(bytes_written, &chunk)?;
            }
        }
        WriteFileMode::Patch => {
            ensure_regular_file_exists(path)?;
            let mut file = OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(map_io_error)?;
            write_seekable_chunks(&mut file, chunks, true, &mut bytes_written).await?;
        }
    }
    Ok(bytes_written)
}

async fn write_seekable_chunks(
    file: &mut fs::File,
    chunks: &mut dyn WriteFileChunkSource,
    require_offset: bool,
    bytes_written: &mut u64,
) -> Result<(), ServiceError> {
    while let Some(chunk) = chunks.next_chunk().await? {
        match chunk.offset {
            Some(offset) => {
                file.seek(SeekFrom::Start(offset)).map_err(map_io_error)?;
            }
            None if require_offset => return Err(ServiceError::InvalidPath),
            None => {}
        }
        file.write_all(&chunk.bytes).map_err(map_io_error)?;
        *bytes_written = add_chunk_len(*bytes_written, &chunk)?;
    }
    Ok(())
}

fn add_chunk_len(current: u64, chunk: &WriteFileChunk) -> Result<u64, ServiceError> {
    current
        .checked_add(chunk.bytes.len() as u64)
        .filter(|value| *value <= MAX_U53)
        .ok_or_else(|| ServiceError::OperationFailed("bytesWritten exceeds u53".to_string()))
}

fn ensure_regular_file_exists(path: &Path) -> Result<(), ServiceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(ServiceError::NotFile),
        Err(err) => Err(map_io_error(err)),
    }
}

fn set_modified_time_best_effort(path: &Path, modified_at_ms: Option<u64>) {
    let Some(modified_at_ms) = modified_at_ms else {
        return;
    };
    let Some(modified_time) = UNIX_EPOCH.checked_add(Duration::from_millis(modified_at_ms)) else {
        return;
    };
    let Ok(file) = OpenOptions::new().write(true).open(path) else {
        return;
    };
    let times = FileTimes::new().set_modified(modified_time);
    let _ = file.set_times(times);
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
    FsEntry {
        name: fs_entry_name(&path),
        path: path.to_string_lossy().to_string(),
        kind,
        size: metadata.is_file().then_some(metadata.len()),
        modified_at_ms: metadata_modified_at_ms(&metadata),
        readonly: metadata.permissions().readonly(),
    }
}

fn metadata_modified_at_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
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
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path).map_err(map_io_error)
    }
    #[cfg(not(unix))]
    {
        let _ = (target, path);
        Err(ServiceError::Unsupported)
    }
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

#[cfg(test)]
mod user_locations_tests {
    use super::*;
    #[tokio::test]
    async fn user_home_and_read_only_trash_never_fall_back_to_root() {
        let dir = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let user = validate_user_home(uid, dir.path().to_path_buf()).unwrap();
        assert!(validate_user_home(0, dir.path().to_path_buf()).is_err());
        assert!(validate_user_home(uid.wrapping_add(1), dir.path().to_path_buf()).is_err());
        assert!(validate_user_home(uid, PathBuf::from("/var/root")).is_err());
        assert!(list_user_trash(&user).await.unwrap().is_empty());
        fs::create_dir(dir.path().join(".Trash")).unwrap();
        fs::write(dir.path().join(".Trash/example 한글.txt"), b"fixture").unwrap();
        let rows = list_user_trash(&user).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "example 한글.txt");
        assert_eq!(rows[0].read_only, Some(true));
        assert!(rows[0].original_parent.is_empty());
        assert!(dir.path().join(".Trash/example 한글.txt").exists());
    }
    #[tokio::test]
    async fn trash_symlink_cannot_select_another_directory() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), dir.path().join(".Trash")).unwrap();
        let user =
            validate_user_home(unsafe { libc::geteuid() }, dir.path().to_path_buf()).unwrap();
        assert!(matches!(
            list_user_trash(&user).await,
            Err(ServiceError::PermissionDenied)
        ));
        assert!(trash_rows(&dir.path().join(".Trash"), b"/var/root/private\0").is_err());
    }
}
