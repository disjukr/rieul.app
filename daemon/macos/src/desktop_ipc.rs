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
fn verify_peer(stream: &UnixStream, uid: u32) -> Result<(), Error> {
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
    let mut buffer = [0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if n <= 0 {
        return Err(Error::Unauthorized);
    }
    let end = buffer
        .iter()
        .position(|b| *b == 0)
        .ok_or(Error::Unauthorized)?;
    let peer = PathBuf::from(std::ffi::OsString::from_vec(buffer[..end].to_vec()))
        .canonicalize()
        .map_err(|_| Error::Unauthorized)?;
    let expected = std::env::current_exe()
        .map_err(|_| Error::Unauthorized)?
        .canonicalize()
        .map_err(|_| Error::Unauthorized)?;
    // Both roles execute the same installed, root-owned system binary. A different
    // same-UID program cannot impersonate the packaged helper by owning the socket.
    if peer != expected {
        return Err(Error::Unauthorized);
    }
    // /Applications is normally root:admin 0775. Permit that shared container
    // only after authenticating the actual running peer's exact signed code hash.
    // The app, executable and all other ancestors remain root-owned/non-writable.
    if !unsafe { rd_peer_matches_self(fd) } {
        return Err(Error::Unauthorized);
    }
    for ancestor in expected.ancestors() {
        let metadata = fs::metadata(ancestor).map_err(|_| Error::Unauthorized)?;
        let applications = ancestor == Path::new("/Applications")
            && metadata.gid() == 80
            && metadata.mode() & 0o002 == 0;
        if metadata.uid() != 0 || (metadata.mode() & 0o022 != 0 && !applications) {
            return Err(Error::Unauthorized);
        }
    }
    Ok(())
}
pub fn proxy(config: &Path) -> Arc<dyn Backend> {
    let profile = rieul_daemon_core::config::profile_id_for_config_path(config);
    Arc::new(Proxy::new(Arc::new(move || {
        let profile = profile.clone();
        Box::pin(async move {
            if unsafe { libc::geteuid() } != 0 || !valid_profile(&profile) {
                return Err(Error::Unauthorized);
            }
            let uid = console_uid()?;
            let stream = UnixStream::connect(endpoint(uid, &profile))
                .await
                .map_err(|_| Error::Unsupported)?;
            verify_peer(&stream, uid)?;
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
