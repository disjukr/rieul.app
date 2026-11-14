use super::store::Dir;
use anyhow::{Result, ensure};
use std::{
    fs::File,
    os::fd::AsRawFd,
    path::Path,
    time::{Duration, Instant},
};
pub(super) const DATA: &str = "/Library/Application Support/rieul";
const BARRIER: &str = "gui-update.lock";
const FORCE_INTENT: &str = "gui-force-update.lock";

pub struct Gate(File);
impl Drop for Gate {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn try_lock(file: File, mode: libc::c_int) -> Result<Option<Gate>> {
    if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } == 0 {
        return Ok(Some(Gate(file)));
    }
    ensure!(
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK),
        "cannot lock GUI barrier"
    );
    Ok(None)
}

pub(super) fn exclusive(data: &Dir) -> Result<Option<Gate>> {
    try_lock(data.read_file(BARRIER)?, libc::LOCK_EX)
}

/// Held only by the verified update worker. The marker is a live lock, not
/// file existence, so a worker crash does not leave launchers stuck.
pub(super) fn announce_force(data: &Dir) -> Result<File> {
    if !data.exists(FORCE_INTENT)? {
        use std::os::unix::fs::PermissionsExt;
        let temporary = "gui-force-update.lock.new";
        data.remove(temporary)?;
        let file = data.create(temporary, 0o600)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o644))?;
        file.sync_all()?;
        data.rename_file(temporary, FORCE_INTENT)?;
    }
    // A POSIX write lock requires a writable descriptor, unlike flock.
    // GUI users can inspect it, but cannot impersonate the update worker.
    // The worker holds its transaction lock; no other code in this process
    // may open/close this inode during the handoff (locks are process-scoped).
    let file = data.open_write(FORCE_INTENT)?;
    record_lock(&file, libc::F_SETLK, libc::F_WRLCK)?;
    Ok(file)
}

fn force_requested_at(data: &Dir) -> Result<bool> {
    if !data.exists(FORCE_INTENT)? {
        return Ok(false);
    }
    let file = data.read_file(FORCE_INTENT)?;
    Ok(record_lock(&file, libc::F_GETLK, libc::F_RDLCK)? == libc::F_WRLCK)
}

fn record_lock(file: &File, command: libc::c_int, kind: libc::c_int) -> Result<libc::c_int> {
    // Zero start/length covers the whole file starting at SEEK_SET.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = kind as _;
    lock.l_whence = libc::SEEK_SET as _;
    if unsafe { libc::fcntl(file.as_raw_fd(), command, &mut lock) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(lock.l_type.into())
}

pub fn force_requested() -> Result<bool> {
    force_requested_at(&Dir::open(Path::new(DATA), 0, true)?)
}

pub(super) fn wait_exclusive(data: &Dir, timeout: Duration) -> Result<Option<Gate>> {
    let start = Instant::now();
    loop {
        if let Some(barrier) = exclusive(data)? {
            return Ok(Some(barrier));
        }
        if start.elapsed() >= timeout {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The launcher keeps this guard while its GUI child runs; CLOEXEC stays set so
/// arbitrary descendants cannot accidentally retain it after the launcher exits.
pub fn shared() -> Result<Option<Gate>> {
    let path = Path::new(DATA).join(BARRIER);
    if !path.try_exists()? {
        return Ok(None);
    }
    let data = Dir::open(Path::new(DATA), 0, true)?;
    loop {
        let file = data.read_file(BARRIER)?;
        ensure!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) } == 0,
            "cannot wait for GUI update"
        );
        let guard = Gate(file);
        // Test after taking the shared lock. A newly launched GUI must not join
        // existing holders while the worker waits for exclusive admission.
        if !force_requested_at(&data)? {
            return Ok(Some(guard));
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_force_from_other_process() {
        let Some(path) = std::env::var_os("RIEUL_GATE_TEST_DIR") else {
            return;
        };
        let data = Dir::open(
            &Path::new(&path).canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        assert_eq!(
            force_requested_at(&data).unwrap(),
            std::env::var("RIEUL_GATE_TEST_EXPECTED").unwrap() == "1"
        );
    }

    #[test]
    fn force_handoff_preserves_exclusive_barrier_and_clears_when_worker_exits() {
        let root = tempfile::tempdir().unwrap();
        let data = Dir::open(
            &root.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        data.create(BARRIER, 0o644).unwrap();
        let incumbent = try_lock(data.read_file(BARRIER).unwrap(), libc::LOCK_SH)
            .unwrap()
            .unwrap();
        assert!(!force_requested_at(&data).unwrap());
        let intent = announce_force(&data).unwrap();
        // A GUI-readable descriptor cannot fake the privileged write lock.
        let readonly = data.read_file(FORCE_INTENT).unwrap();
        assert!(record_lock(&readonly, libc::F_SETLK, libc::F_WRLCK).is_err());
        let child_query = |expected: &str| {
            assert!(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "root_update::gate::tests::inspect_force_from_other_process"
                    ])
                    .env("RIEUL_GATE_TEST_DIR", root.path())
                    .env("RIEUL_GATE_TEST_EXPECTED", expected)
                    .status()
                    .unwrap()
                    .success()
            );
        };
        child_query("1");
        assert!(wait_exclusive(&data, Duration::ZERO).unwrap().is_none());
        drop(incumbent);
        let barrier = wait_exclusive(&data, Duration::ZERO).unwrap().unwrap();
        assert!(
            try_lock(data.read_file(BARRIER).unwrap(), libc::LOCK_SH)
                .unwrap()
                .is_none()
        );
        drop(intent);
        child_query("0");
        drop(barrier);
        assert!(
            try_lock(data.read_file(BARRIER).unwrap(), libc::LOCK_SH)
                .unwrap()
                .is_some()
        );
    }
}
