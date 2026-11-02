//! The helper inherits the GUI user's identity and lifetime; it never starts as root.
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
pub struct Helper(Option<std::sync::mpsc::Sender<()>>);
impl Drop for Helper {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            let _ = stop.send(());
        }
    }
}
#[cfg(target_os = "macos")]
fn spawn(path: &Path, config: &Path) -> anyhow::Result<Child> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
        "desktop helper is not an installed root-owned binary"
    );
    Ok(Command::new(path)
        .arg("desktop-user")
        .arg("--config")
        .arg(config)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?)
}
pub fn start(executable: &Path, config: &Path) -> anyhow::Result<Helper> {
    #[cfg(target_os = "macos")]
    {
        anyhow::ensure!(
            unsafe { libc::geteuid() } != 0,
            "desktop helper requires a user GUI"
        );
        let path = helper_path(executable)?;
        let config = config.to_path_buf();
        let mut child = Some(spawn(&path, &config)?);
        let (stop, receiver) = std::sync::mpsc::channel();
        let mut retry_at = std::time::Instant::now();
        std::thread::spawn(move || {
            loop {
                if receiver.recv_timeout(std::time::Duration::from_millis(500))
                    != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    if let Some(mut child) = child {
                        drop(child.stdin.take());
                        let _ = child.wait();
                    }
                    return;
                }
                if let Some(process) = child.as_mut() {
                    if matches!(process.try_wait(), Ok(Some(_))) {
                        child = None;
                        retry_at = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    }
                } else if std::time::Instant::now() >= retry_at {
                    // A new daemon may start after an update. Restart only an empty
                    // helper; no attachment, input or control state is restored.
                    retry_at = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    match spawn(&path, &config) {
                        Ok(next) => child = Some(next),
                        Err(error) => eprintln!("Desktop helper restart unavailable: {error}"),
                    }
                }
            }
        });
        Ok(Helper(Some(stop)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (executable, config);
        Ok(Helper(None))
    }
}
#[cfg(any(target_os = "macos", test))]
fn helper_path(executable: &Path) -> anyhow::Result<PathBuf> {
    let macos = executable
        .parent()
        .ok_or_else(|| anyhow::anyhow!("GUI executable path missing"))?;
    anyhow::ensure!(
        macos.file_name() == Some(std::ffi::OsStr::new("MacOS")),
        "desktop helper requires installed app layout"
    );
    Ok(macos
        .parent()
        .ok_or_else(|| anyhow::anyhow!("app Contents missing"))?
        .join("Library/LaunchServices/rieul-macos-system"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_is_resolved_only_inside_installed_app() {
        assert_eq!(
            helper_path(Path::new(
                "/Applications/Rieul.app/Contents/MacOS/rieul-gui"
            ))
            .unwrap(),
            Path::new("/Applications/Rieul.app/Contents/Library/LaunchServices/rieul-macos-system")
        );
        assert!(helper_path(Path::new("/tmp/rieul-gui")).is_err());
    }
}
