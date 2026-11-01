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
    pub fn from_directory(file: File, path: PathBuf, uid: u32) -> Result<Self> {
        let m = file.metadata()?;
        ensure!(
            m.is_dir() && m.uid() == uid && m.mode() & 0o022 == 0,
            "unprotected directory"
        );
        no_acl(file.as_raw_fd())?;
        Ok(Self { file, path, uid })
    }
    fn names(&self) -> Result<Vec<String>> {
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        ensure!(fd >= 0, "cannot enumerate directory");
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            };
            bail!("fdopendir failed");
        }
        let result = (|| {
            let mut names = Vec::new();
            loop {
                let entry = unsafe { libc::readdir(stream) };
                if entry.is_null() {
                    break;
                }
                let name =
                    unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str()?;
                if name != "." && name != ".." {
                    names.push(name.to_owned());
                    ensure!(names.len() <= 100_000, "directory too large");
                }
            }
            Ok(names)
        })();
        unsafe {
            libc::closedir(stream);
        };
        result
    }
    pub fn copy_contents(&self, to: &Dir) -> Result<()> {
        fn copy(
            from: &Dir,
            to: &Dir,
            depth: usize,
            count: &mut usize,
            bytes: &mut u64,
        ) -> Result<()> {
            ensure!(depth <= 64, "copy depth exceeded");
            for name in from.names()? {
                *count += 1;
                ensure!(*count <= 100_000, "too many copy entries");
                let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
                ensure!(
                    unsafe {
                        libc::fstatat(
                            from.file.as_raw_fd(),
                            component(&name)?.as_ptr(),
                            info.as_mut_ptr(),
                            libc::AT_SYMLINK_NOFOLLOW,
                        )
                    } == 0,
                    "cannot inspect copy source"
                );
                let info = unsafe { info.assume_init() };
                match info.st_mode as u32 & libc::S_IFMT as u32 {
                    mode if mode == libc::S_IFDIR as u32 => {
                        copy(
                            &from.child(&name)?,
                            &to.create_dir(&name, 0o755)?,
                            depth + 1,
                            count,
                            bytes,
                        )?;
                    }
                    mode if mode == libc::S_IFREG as u32 => {
                        let input = from.read_file(&name)?;
                        let m = input.metadata()?;
                        ensure!(
                            m.mode() & 0o7000 == 0 && m.len() <= 512 * 1024 * 1024,
                            "unsafe copy file"
                        );
                        *bytes = bytes.checked_add(m.len()).context("copy size overflow")?;
                        ensure!(*bytes <= 2 * 1024 * 1024 * 1024, "copy too large");
                        let mut out =
                            to.create(&name, if m.mode() & 0o111 != 0 { 0o755 } else { 0o644 })?;
                        ensure!(
                            std::io::copy(&mut input.take(m.len() + 1), &mut out)? == m.len(),
                            "copy source changed"
                        );
                        out.sync_all()?;
                        to.sync()?;
                    }
                    mode if mode == libc::S_IFLNK as u32 => {
                        let mut buf = [0u8; 4096];
                        let n = unsafe {
                            libc::readlinkat(
                                from.file.as_raw_fd(),
                                component(&name)?.as_ptr(),
                                buf.as_mut_ptr().cast(),
                                buf.len(),
                            )
                        };
                        ensure!(n > 0 && (n as usize) < buf.len(), "invalid copy link");
                        let target = std::str::from_utf8(&buf[..n as usize])?;
                        ensure!(!Path::new(target).is_absolute(), "absolute copy link");
                        to.symlink(&name, Path::new(target))?;
                    }
                    _ => bail!("special copy entry"),
                }
            }
            to.sync()
        }
        copy(self, to, 0, &mut 0, &mut 0)
    }
    pub fn copy_file(&self, name: &str, to: &Dir, target: &str, mode: u32) -> Result<()> {
        let mut input = self.read_file(name)?;
        let mut out = to.create(target, mode)?;
        ensure!(
            input.metadata()?.len() <= 512 * 1024 * 1024,
            "copy file too large"
        );
        std::io::copy(&mut input, &mut out)?;
        ensure!(
            unsafe { libc::fchmod(out.as_raw_fd(), mode as libc::mode_t) } == 0,
            "cannot set copied mode"
        );
        out.sync_all()?;
        to.sync()
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
    #[cfg(target_os = "macos")]
    pub fn exchange_app_entry(&self, public_fd: i32) -> Result<()> {
        self.require_private()?;
        extern "C" {
            fn renameatx_np(
                fromfd: i32,
                from: *const libc::c_char,
                tofd: i32,
                to: *const libc::c_char,
                flags: u32,
            ) -> i32;
        }
        ensure!(
            unsafe {
                renameatx_np(
                    public_fd,
                    c"Rieul.app".as_ptr(),
                    self.file.as_raw_fd(),
                    c"Rieul.app".as_ptr(),
                    2,
                )
            } == 0,
            "atomic public app exchange failed"
        );
        self.sync()
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
