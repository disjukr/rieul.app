//! Descriptor-relative storage. Production state is under a root-only directory.
use anyhow::{bail, ensure, Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
};

pub(super) struct Dir {
    file: File,
    pub path: PathBuf,
    uid: u32,
}
pub(super) struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        // Explicit unlock avoids retaining the lock in a concurrently forked
        // child during the short interval before its CLOEXEC descriptors close.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn c(value: &std::ffi::OsStr) -> Result<CString> {
    Ok(CString::new(value.as_bytes())?)
}
fn component(value: &str) -> Result<CString> {
    ensure!(
        !value.is_empty() && value != "." && value != ".." && !value.contains('/'),
        "invalid storage name"
    );
    Ok(CString::new(value)?)
}
fn file(fd: i32) -> Result<File> {
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(super) fn no_acl(fd: i32) -> Result<()> {
    #[cfg(target_os = "macos")]
    unsafe {
        extern "C" {
            fn acl_get_fd(fd: i32) -> *mut libc::c_void;
            fn acl_free(p: *mut libc::c_void) -> i32;
            fn acl_valid(p: *mut libc::c_void) -> i32;
            fn acl_get_entry(p: *mut libc::c_void, id: i32, entry: *mut *mut libc::c_void) -> i32;
        }
        let acl = acl_get_fd(fd);
        if acl.is_null() {
            ensure!(
                std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT),
                "cannot inspect ACL"
            );
        } else {
            let mut entry = std::ptr::null_mut();
            let empty = acl_valid(acl) == 0
                && acl_get_entry(acl, 0, &mut entry) == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL);
            acl_free(acl);
            ensure!(empty, "extended ACL not allowed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = fd;
    Ok(())
}
impl Dir {
    pub fn open(path: &Path, uid: u32, protected_chain: bool) -> Result<Self> {
        ensure!(path.is_absolute(), "absolute storage path required");
        let mut current = file(unsafe {
            libc::open(
                c(Path::new("/").as_os_str())?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        for part in path.components() {
            match part {
                Component::RootDir => continue,
                Component::Normal(name) => {
                    current = file(unsafe {
                        libc::openat(
                            current.as_raw_fd(),
                            c(name)?.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    })?;
                    if protected_chain {
                        let m = current.metadata()?;
                        ensure!(
                            m.uid() == uid && m.mode() & 0o022 == 0,
                            "unprotected ancestor"
                        );
                        no_acl(current.as_raw_fd())?;
                    }
                }
                _ => bail!("noncanonical storage path"),
            }
        }
        let m = current.metadata()?;
        ensure!(
            m.uid() == uid && m.mode() & 0o022 == 0,
            "unprotected storage directory"
        );
        no_acl(current.as_raw_fd())?;
        Ok(Self {
            file: current,
            path: path.to_owned(),
            uid,
        })
    }
    pub fn create_dir(&self, name: &str, mode: u32) -> Result<Self> {
        let name_c = component(name)?;
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), mode as libc::mode_t) }
            != 0
        {
            ensure!(
                std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST),
                "mkdir failed"
            );
        }
        self.sync()?;
        self.child(name)
    }
    pub fn child(&self, name: &str) -> Result<Self> {
        let child = file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                component(name)?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        let m = child.metadata()?;
        ensure!(
            m.uid() == self.uid && m.mode() & 0o022 == 0,
            "unsafe child directory"
        );
        no_acl(child.as_raw_fd())?;
        Ok(Self {
            file: child,
            path: self.path.join(name),
            uid: self.uid,
        })
    }
    pub fn create(&self, name: &str, mode: u32) -> Result<File> {
        file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                component(name)?.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        })
    }
    pub fn read_file(&self, name: &str) -> Result<File> {
        let f = file(unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                component(name)?.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        })?;
        let m = f.metadata()?;
        ensure!(
            m.is_file() && m.uid() == self.uid && m.nlink() == 1 && m.mode() & 0o022 == 0,
            "unsafe regular file"
        );
        no_acl(f.as_raw_fd())?;
        Ok(f)
    }
    pub fn sync(&self) -> Result<()> {
        self.file.sync_all().context("sync directory")
    }
    pub fn remove(&self, name: &str) -> Result<()> {
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), component(name)?.as_ptr(), 0) } != 0 {
            ensure!(
                std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT),
                "unlink failed"
            );
        }
        self.sync()
    }
    pub fn exists(&self, name: &str) -> Result<bool> {
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                component(name)?.as_ptr(),
                st.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Ok(true);
        }
        ensure!(
            std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT),
            "cannot inspect entry"
        );
        Ok(false)
    }
    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        if !self.exists(name)? {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        self.read_file(name)?.take(65537).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 65536, "oversized record");
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        // One lock holder writes fixed records. Stale temp from a crash is safe to
        // unlink by descriptor; it is never opened or followed.
        let temp = format!("{name}.new");
        self.remove(&temp)?;
        let mut out = self.create(&temp, 0o600)?;
        out.write_all(&serde_json::to_vec(value)?)?;
        out.sync_all()?;
        ensure!(
            unsafe {
                libc::renameat(
                    self.file.as_raw_fd(),
                    component(&temp)?.as_ptr(),
                    self.file.as_raw_fd(),
                    component(name)?.as_ptr(),
                )
            } == 0,
            "record rename failed"
        );
        self.sync()
    }
    pub fn lock(&self) -> Result<Lock> {
        if !self.exists("lock")? {
            match self.create("lock", 0o600) {
                Ok(f) => f.sync_all()?,
                Err(e) if self.exists("lock")? => {
                    let _ = e;
                }
                Err(e) => return Err(e),
            }
        }
        let f = self.read_file("lock")?;
        ensure!(
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "another updater is active"
        );
        Ok(Lock(f))
    }
    pub fn symlink(&self, name: &str, target: &Path) -> Result<()> {
        ensure!(
            unsafe {
                libc::symlinkat(
                    c(target.as_os_str())?.as_ptr(),
                    self.file.as_raw_fd(),
                    component(name)?.as_ptr(),
                )
            } == 0,
            "symlink creation failed"
        );
        self.sync()
    }
    /// Only private updater staging may be discarded. Never follows links.
    pub fn discard_child(&self, name: &str) -> Result<()> {
        self.require_private()?;
        if !self.exists(name)? {
            return Ok(());
        }
        let child = self.child(name)?;
        fn clear(dir: &Dir) -> Result<()> {
            for item in std::fs::read_dir(&dir.path)? {
                let item = item?;
                let name = item.file_name();
                let name = name.to_str().context("non-UTF8 private staging entry")?;
                if item.file_type()?.is_dir() {
                    let child = dir.child(name)?;
                    clear(&child)?;
                    ensure!(
                        unsafe {
                            libc::unlinkat(
                                dir.file.as_raw_fd(),
                                component(name)?.as_ptr(),
                                libc::AT_REMOVEDIR,
                            )
                        } == 0,
                        "staging directory removal failed"
                    );
                } else {
                    dir.remove(name)?;
                }
            }
            dir.sync()
        }
        clear(&child)?;
        ensure!(
            unsafe {
                libc::unlinkat(
                    self.file.as_raw_fd(),
                    component(name)?.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            } == 0,
            "staging removal failed"
        );
        self.sync()
    }
    pub fn require_private(&self) -> Result<()> {
        ensure!(
            self.file.metadata()?.mode() & 0o077 == 0,
            "updater state must be private"
        );
        Ok(())
    }
    /// Both directories are already open and protected. No path traversal,
    /// temporary absence or copy-and-delete fallback is permitted.
    #[cfg(target_os = "macos")]
    pub fn exchange(&self, name: &str, other: &Dir, other_name: &str) -> Result<()> {
        ensure!(
            self.identity()?.0 == other.identity()?.0,
            "cross-volume exchange forbidden"
        );
        extern "C" {
            fn renameatx_np(
                fromfd: i32,
                from: *const libc::c_char,
                tofd: i32,
                to: *const libc::c_char,
                flags: u32,
            ) -> i32;
        }
        const RENAME_SWAP: u32 = 0x00000002;
        ensure!(
            unsafe {
                renameatx_np(
                    self.file.as_raw_fd(),
                    component(name)?.as_ptr(),
                    other.file.as_raw_fd(),
                    component(other_name)?.as_ptr(),
                    RENAME_SWAP,
                )
            } == 0,
            "atomic exchange failed: {}",
            std::io::Error::last_os_error()
        );
        self.sync()?;
        other.sync()
    }
    pub fn identity(&self) -> Result<(u64, u64)> {
        let m = self.file.metadata()?;
        Ok((m.dev(), m.ino()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releasing_guard_unlocks_even_with_inherited_descriptor() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open(
            &temp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        let guard = dir.lock().unwrap();
        // dup reproduces the shared open-file description inherited across fork.
        let inherited = guard.0.try_clone().unwrap();
        assert!(dir.lock().is_err());
        drop(guard);
        let next = dir.lock().unwrap();
        drop(inherited);
        drop(next);
    }
}
