use super::store::Dir;
use anyhow::{ensure, Result};
use std::{fs::File, os::fd::AsRawFd, path::Path};
pub(super) const DATA: &str = "/Library/Application Support/rieul";
pub(super) struct Gate(File);
impl Drop for Gate {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
pub(super) fn exclusive(data: &Dir) -> Result<Option<Gate>> {
    let file = data.read_file("gui-update.lock")?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(Gate(file)));
    }
    ensure!(
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK),
        "cannot lock GUI barrier"
    );
    Ok(None)
}
/// The launcher keeps this guard while its GUI child runs; CLOEXEC stays set so
/// arbitrary descendants cannot accidentally retain it after the launcher exits.
pub fn shared() -> Result<Option<impl std::any::Any>> {
    let path = Path::new(DATA).join("gui-update.lock");
    if !path.try_exists()? {
        return Ok(None);
    }
    let data = Dir::open(Path::new(DATA), 0, true)?;
    let file = data.read_file("gui-update.lock")?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) } == 0,
        "cannot wait for GUI update"
    );
    Ok(Some(Gate(file)))
}
