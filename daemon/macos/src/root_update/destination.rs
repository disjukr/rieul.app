//! The single public destination is not a protected directory. Never use its
//! exchanged-out entry as executable input without private-storage validation.
use super::store::Dir;
use anyhow::{Result, ensure};
use std::{
    ffi::CString,
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

pub(super) struct AppDestination {
    file: File,
    path: PathBuf,
}
impl AppDestination {
    pub fn open() -> Result<Self> {
        Self::open_at(Path::new("/Applications"), 0)
    }
    fn open_at(path: &Path, uid: u32) -> Result<Self> {
        let name = CString::new(path.as_os_str().as_bytes())?;
        let fd = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        ensure!(fd >= 0, "cannot open app destination");
        let file = unsafe { File::from_raw_fd(fd) };
        let m = file.metadata()?;
        ensure!(
            m.uid() == uid && m.mode() & 0o002 == 0,
            "unexpected public app parent"
        );
        Ok(Self {
            file,
            path: path.to_owned(),
        })
    }
    #[cfg(test)]
    pub fn fixture(path: &Path) -> Result<Self> {
        Self::open_at(path, unsafe { libc::geteuid() })
    }
    pub fn open_entry(&self) -> Result<File> {
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                c"Rieul.app".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        ensure!(fd >= 0, "app entry is absent or not a directory");
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    /// A held directory descriptor prevents parent substitution. Identity is
    /// checked before AND after the swap; a racing entry is never trusted.
    pub fn identity(&self) -> Result<(u64, u64)> {
        let m = self.open_entry()?.metadata()?;
        Ok((m.dev(), m.ino()))
    }
    #[cfg(all(target_os = "macos", feature = "updater-device-repair"))]
    pub fn repair_volume(&self) -> Result<(u64, [u8; 16])> {
        Ok((
            self.file.metadata()?.dev(),
            super::device_repair::volume_uuid(&self.file)?,
        ))
    }
    #[cfg(target_os = "macos")]
    pub fn exchange(&self, stage: &Dir, old: (u64, u64), new: (u64, u64)) -> Result<()> {
        ensure!(
            self.identity()? == old && stage.child("Rieul.app")?.identity()? == new,
            "app identity changed before exchange"
        );
        ensure!(
            self.file.metadata()?.dev() == stage.identity()?.0,
            "cross-volume app exchange"
        );
        stage.exchange_app_entry(self.file.as_raw_fd())?;
        self.file.sync_all()?;
        ensure!(
            self.identity()? == new && stage.child("Rieul.app")?.identity()? == old,
            "app raced exchange; exchanged-out entry is untrusted"
        );
        Ok(())
    }
    pub fn snapshot(&self, stage: &Dir) -> Result<(u64, u64)> {
        self.snapshot_entry(self.open_entry()?, stage)
    }
    pub fn snapshot_entry(&self, file: File, stage: &Dir) -> Result<(u64, u64)> {
        let source = Dir::from_directory(file, self.path.join("Rieul.app"), 0)?;
        let identity = source.identity()?;
        source.copy_contents(&stage.create_dir("Rieul.app", 0o755)?)?;
        ensure!(
            self.identity()? == identity,
            "public app changed during snapshot"
        );
        Ok(identity)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    #[cfg(target_os = "macos")]
    fn allows_group_writable_app_parent_without_weakening_private_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let public = base.join("Applications");
        std::fs::create_dir(&public).unwrap();
        std::fs::set_permissions(&public, std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(Dir::open(&public, unsafe { libc::geteuid() }, false).is_err());
        let stage_path = base.join("stage");
        std::fs::create_dir(&stage_path).unwrap();
        std::fs::set_permissions(&stage_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let stage = Dir::open(&stage_path, unsafe { libc::geteuid() }, false).unwrap();
        std::fs::create_dir(public.join("Rieul.app")).unwrap();
        let candidate = stage.create_dir("Rieul.app", 0o755).unwrap();
        let destination = AppDestination::fixture(&public).unwrap();
        let old = destination.identity().unwrap();
        let new = candidate.identity().unwrap();
        destination.exchange(&stage, old, new).unwrap();
        assert_eq!(destination.identity().unwrap(), new);
        assert!(destination.exchange(&stage, old, new).is_err());
    }
    #[test]
    fn rejects_symlink_app_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        std::os::unix::fs::symlink("/tmp", base.join("Rieul.app")).unwrap();
        assert!(AppDestination::fixture(&base).unwrap().identity().is_err());
    }
}
