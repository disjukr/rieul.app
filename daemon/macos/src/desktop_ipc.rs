//! Root <-> active console user only. Socket pathname is routing, never authentication.
use rieul_daemon_host::{
    desktop::{Backend, Error},
    desktop_ipc::{Connection, Proxy},
};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStringExt,
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::net::{UnixListener, UnixStream};
fn console_uid() -> Result<u32, Error> {
    let uid = fs::metadata("/dev/console")
        .map_err(|_| Error::Unauthorized)?
        .uid();
    if uid == 0 {
        Err(Error::Unauthorized)
    } else {
        Ok(uid)
    }
}
fn directory(uid: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/rieul-desktop-{uid}"))
}
fn endpoint(uid: u32, profile: &str) -> PathBuf {
    directory(uid).join(format!("{profile}.sock"))
}
fn valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile.len() <= 128
        && profile
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
unsafe extern "C" {
    fn rd_peer_matches_self(fd: libc::c_int) -> bool;
}
fn verify_peer(stream: &UnixStream, uid: u32) -> Result<libc::pid_t, Error> {
    let fd = stream.as_raw_fd();
    let (mut peer_uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(fd, &mut peer_uid, &mut gid) } != 0 || peer_uid != uid {
        return Err(Error::Unauthorized);
    }
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
        || pid <= 0
    {
        return Err(Error::Unauthorized);
    }
    // Daemon and helper run from different installed copies. Authenticate the
    // exact running code rather than path equality. UID 0's runtime is private:
    // the user helper must not need to traverse it to authenticate its peer.
    if !unsafe { rd_peer_matches_self(fd) } {
        return Err(Error::Unauthorized);
    }
    let expected = if uid == 0 {
        std::env::current_exe().map_err(|_| Error::Unauthorized)?
    } else {
        let mut buffer = [0u8; 4096];
        let n = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if n <= 0 { return Err(Error::Unauthorized); }
        let end = buffer.iter().position(|b| *b == 0).ok_or(Error::Unauthorized)?;
        PathBuf::from(std::ffi::OsString::from_vec(buffer[..end].to_vec()))
    }.canonicalize().map_err(|_| Error::Unauthorized)?;
    // Validate the helper's protected installation in both directions.
    verify_helper_path(&expected)?;
    // Fail closed if peer code changed while inspecting the installation.
    if !unsafe { rd_peer_matches_self(fd) } {
        return Err(Error::Unauthorized);
    }
    Ok(pid)
}
fn verify_helper_path(expected: &Path) -> Result<(), Error> {
    for ancestor in expected.ancestors() {
        let metadata = fs::metadata(ancestor).map_err(|_| Error::Unauthorized)?;
        if !safe_helper_ancestor(ancestor, metadata.uid(), metadata.gid(), metadata.mode()) {
            return Err(Error::Unauthorized);
        }
    }
    Ok(())
}
fn safe_helper_ancestor(path: &Path, uid: u32, gid: u32, mode: u32) -> bool {
    let applications = path == Path::new("/Applications") && gid == 80 && mode & 0o002 == 0;
    uid == 0 && (mode & 0o022 == 0 || applications)
}
pub fn proxy(config: &Path) -> Arc<dyn Backend> {
    let profile = rieul_daemon_core::config::profile_id_for_config_path(config);
    let login = Arc::new(std::sync::Mutex::new(None));
    let previous_process = Arc::new(std::sync::Mutex::new(None::<libc::pid_t>));
    Arc::new(Proxy::new(Arc::new(move || {
        let login = login.clone();
        let previous_process = previous_process.clone();
        let profile = profile.clone();
        Box::pin(async move {
            if unsafe { libc::geteuid() } != 0 || !valid_profile(&profile) {
                return Err(Error::Unauthorized);
            }
            let uid = console_uid()?;
            { let mut bound = login.lock().map_err(|_| Error::Backend)?;
              if bound.is_some_and(|previous| previous != uid) { return Err(Error::Unauthorized); }
              *bound = Some(uid); }
            let stream = UnixStream::connect(endpoint(uid, &profile))
                .await
                .map_err(|_| Error::Unsupported)?;
            let pid = verify_peer(&stream, uid)?;
            {
                let mut previous = previous_process.lock().map_err(|_| Error::Backend)?;
                if let Some(old) = *previous {
                    // A new socket alone does not prove the old capture owner exited.
                    // PID reuse only delays recovery; it cannot falsely establish death.
                    if unsafe { libc::kill(old, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                        return Err(Error::Busy);
                    }
                }
                *previous = Some(pid);
            }
            if console_uid()? != uid {
                return Err(Error::Stale);
            }
            Ok(Box::new(stream) as Connection)
        })
    })))
}
struct SocketPath(PathBuf);
impl Drop for SocketPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub async fn run(config: &Path) -> anyhow::Result<()> {
    let uid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        uid != 0 && console_uid() == Ok(uid),
        "desktop helper requires active console user"
    );
    let profile = rieul_daemon_core::config::profile_id_for_config_path(config);
    anyhow::ensure!(valid_profile(&profile), "invalid desktop profile");
    let dir = directory(uid);
    match fs::create_dir(&dir) {
        Ok(()) => fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    let metadata = fs::symlink_metadata(&dir)?;
    anyhow::ensure!(
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
        "unsafe desktop socket directory"
    );
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(format!("{profile}.lock")))?;
    anyhow::ensure!(
        lock.metadata()?.uid() == uid && lock.metadata()?.is_file(),
        "unsafe desktop helper lock"
    );
    anyhow::ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "desktop helper already running"
    );
    let path = endpoint(uid, &profile);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        anyhow::ensure!(
            metadata.file_type().is_socket() && metadata.uid() == uid,
            "unsafe stale desktop socket"
        );
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let _path = SocketPath(path);
    let (closed_tx, mut closed_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        parent_closed().await;
        let _ = closed_tx.send(true);
    });
    loop {
        let (stream, _) = tokio::select! {
            connection=listener.accept()=>connection?,
            _=closed_rx.changed()=>return Ok(()),
        };
        if verify_peer(&stream, 0).is_err() || console_uid() != Ok(uid) {
            continue;
        }
        let backend = Arc::new(
            crate::desktop::MacDesktop::for_user_session()
                .map_err(|e| anyhow::anyhow!("desktop backend: {e:?}"))?,
        );
        // One root channel owns the helper. Any channel loss retires the process;
        // a restart is explicit, never an input/control replay.
        let result = rieul_daemon_host::desktop_ipc::serve_until(stream, backend, async {
            let _ = closed_rx.changed().await;
        })
        .await;
        return Err(anyhow::anyhow!("desktop IPC ended: {result:?}"));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn audit_token_authenticates_same_running_code_without_desktop_access() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(unsafe { rd_peer_matches_self(a.as_raw_fd()) });
        assert!(!unsafe { rd_peer_matches_self(-1) });
    }
    #[tokio::test]
    async fn different_signed_program_cannot_impersonate_helper() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peer.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let mut child = tokio::process::Command::new("/usr/bin/python3")
            .arg("-c")
            .arg("import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.recv(1)")
            .arg(&path)
            .kill_on_drop(true)
            .spawn().unwrap();
        let (stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
        assert!(!unsafe { rd_peer_matches_self(stream.as_raw_fd()) });
        drop(stream);
        child.wait().await.unwrap();
    }
    // Child endpoint used only by the isolated copied-executable tests below.
    #[tokio::test]
    async fn copied_code_peer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let Some(path) = std::env::var_os("RIEUL_TEST_CODE_PEER") else { return; };
        let mut stream = UnixStream::connect(path).await.unwrap();
        if std::env::var_os("RIEUL_TEST_INVALIDATE_SELF").is_some() {
            unsafe extern "C" {
                fn csops(pid: libc::pid_t, op: u32, address: *mut libc::c_void, size: usize) -> i32;
            }
            assert_eq!(unsafe { csops(libc::getpid(), 1, std::ptr::null_mut(), 0) }, 0);
            let mut status = 0u32;
            assert_eq!(unsafe { csops(libc::getpid(), 0, (&mut status as *mut u32).cast(), 4) }, 0);
            assert_eq!(status & 1, 0);
            stream.write_u8(2).await.unwrap();
            let _ = stream.read_u8().await;
            return;
        }
        let accepted = if let Ok(uid) = std::env::var("RIEUL_TEST_FULL_PEER_UID") {
            verify_peer(&stream, uid.parse().unwrap()).is_ok()
        } else {
            unsafe { rd_peer_matches_self(stream.as_raw_fd()) }
        };
        stream.write_all(&[u8::from(accepted)]).await.unwrap();
        let mut done = [0];
        stream.read_exact(&mut done).await.unwrap();
    }
    async fn copied_code_authentication(resign: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("copied-helper");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        if resign {
            assert!(std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-", "--identifier", "invalid.rieul.test-peer"])
                .arg(&executable).status().unwrap().success());
        }
        let path = dir.path().join("peer.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let mut child = tokio::process::Command::new(&executable)
            .args(["--exact", "desktop_ipc::tests::copied_code_peer"])
            .env("RIEUL_TEST_CODE_PEER", &path)
            .kill_on_drop(true).spawn().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(unsafe { rd_peer_matches_self(stream.as_raw_fd()) }, !resign);
            assert_eq!(stream.read_u8().await.unwrap(), u8::from(!resign));
            stream.write_u8(1).await.unwrap();
            assert!(child.wait().await.unwrap().success());
        }).await.unwrap();
    }
    #[tokio::test]
    async fn same_code_at_different_path_authenticates_both_directions() {
        copied_code_authentication(false).await;
    }
    #[tokio::test]
    async fn resigned_copy_is_not_the_same_code_identity() {
        copied_code_authentication(true).await;
    }
    #[tokio::test]
    async fn invalidated_peer_signature_is_rejected() {
        use std::os::unix::process::ExitStatusExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peer.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "desktop_ipc::tests::copied_code_peer"])
            .env("RIEUL_TEST_CODE_PEER", &path)
            .env("RIEUL_TEST_INVALIDATE_SELF", "1")
            .kill_on_drop(true).spawn().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let (mut stream, _) = listener.accept().await.unwrap();
            match stream.read_u8().await {
                Ok(2) => {
                    assert!(!unsafe { rd_peer_matches_self(stream.as_raw_fd()) });
                    let _ = stream.write_u8(1).await;
                    let status = child.wait().await.unwrap();
                    assert!(status.success() || status.signal() == Some(libc::SIGKILL));
                    eprintln!("peer reported CS_VALID cleared and was rejected; exit: {status}");
                }
                Err(_) => {
                    let status = child.wait().await.unwrap();
                    assert_eq!(status.signal(), Some(libc::SIGKILL));
                    assert!(!unsafe { rd_peer_matches_self(stream.as_raw_fd()) });
                    eprintln!("kernel terminated invalidated peer: {status}; live-invalid coverage unavailable");
                }
                other => panic!("unexpected invalidation result: {other:?}"),
            }
        }).await.unwrap();
    }
    /// Run only in an isolated guest: root test binary under private runtime,
    /// identical root-owned helper copy elsewhere, invoked as an existing user.
    #[tokio::test]
    #[ignore = "requires isolated VM root-owned private runtime and user helper copies"]
    async fn private_runtime_authenticates_user_helper() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        assert_eq!(unsafe { libc::geteuid() }, 0);
        let helper = PathBuf::from(std::env::var_os("RIEUL_TEST_INSTALLED_HELPER").unwrap());
        let uid: u32 = std::env::var("RIEUL_TEST_HELPER_UID").unwrap().parse().unwrap();
        assert_ne!(uid, 0);
        let socket = helper.parent().unwrap().join("test.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();
        let _socket = SocketPath(socket.clone());
        let mut child = tokio::process::Command::new("/usr/bin/sudo")
            .args(["-n", "-u", &format!("#{uid}"), "/usr/bin/env"])
            .arg(format!("RIEUL_TEST_CODE_PEER={}", socket.display()))
            .arg("RIEUL_TEST_FULL_PEER_UID=0")
            .arg(&helper).args(["--exact", "desktop_ipc::tests::copied_code_peer"])
            .kill_on_drop(true).spawn().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(verify_peer(&stream, uid).is_ok());
            assert_eq!(stream.read_u8().await.unwrap(), 1);
            stream.write_u8(1).await.unwrap();
            assert!(child.wait().await.unwrap().success());
        }).await.unwrap();
    }
    #[test]
    fn unsafe_helper_installations_are_rejected() {
        let executable = Path::new("/Applications/Rieul.app/Contents/Library/LaunchServices/rieul-macos-system");
        assert!(safe_helper_ancestor(executable, 0, 0, 0o755));
        assert!(!safe_helper_ancestor(executable, 501, 0, 0o755));
        assert!(!safe_helper_ancestor(executable, 0, 0, 0o775));
        assert!(!safe_helper_ancestor(executable, 0, 0, 0o757));
        assert!(safe_helper_ancestor(Path::new("/Applications"), 0, 80, 0o775));
        assert!(!safe_helper_ancestor(Path::new("/Applications"), 0, 80, 0o777));
        assert!(!safe_helper_ancestor(Path::new("/Applications"), 0, 20, 0o775));
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("helper");
        fs::write(&file, b"untrusted").unwrap();
        assert_eq!(verify_helper_path(&file), Err(Error::Unauthorized));
        assert_eq!(verify_helper_path(&dir.path().join("missing")), Err(Error::Unauthorized));
    }
    #[test]
    fn profile_cannot_escape_endpoint() {
        assert!(valid_profile("0123abcd"));
        for p in ["", "../other", "a/b", "a.sock\0"] {
            assert!(!valid_profile(p));
        }
    }
    #[tokio::test]
    async fn peer_uid_is_authenticated_before_any_desktop_access() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(
            verify_peer(&a, unsafe { libc::geteuid() }.wrapping_add(1)),
            Err(Error::Unauthorized)
        );
    }
}

async fn parent_closed() {
    use std::os::fd::{FromRawFd, OwnedFd};
    // The GUI supplies a pipe. AsyncFd avoids uncancelable blocking stdin reads
    // keeping a retired helper/runtime alive after native cleanup completes.
    let fd = unsafe { libc::dup(libc::STDIN_FILENO) };
    if fd < 0 {
        return;
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return;
    }
    let Ok(input) = tokio::io::unix::AsyncFd::new(fd) else {
        return;
    };
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    tokio::select! {
        _=async {
            loop {
                let Ok(mut ready)=input.readable().await else {return;};
                match ready.try_io(|fd| {
                    let mut byte=0u8;
                    let n=unsafe{libc::read(fd.as_raw_fd(),(&mut byte as *mut u8).cast(),1)};
                    if n<0 {Err(std::io::Error::last_os_error())} else {Ok(n)}
                }) {Ok(_)=>return,Err(_)=>continue}
            }
        }=>(),
        _=async {if let Some(ref mut signal)=terminate {signal.recv().await;}else{std::future::pending::<()>().await;}}=>(),
    }
}
