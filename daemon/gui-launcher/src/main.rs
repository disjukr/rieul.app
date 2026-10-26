#![cfg_attr(windows, windows_subsystem = "windows")]
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};

#[derive(Deserialize)]
struct Manifest {
    platform: String,
    arch: String,
    node_version: String,
    bun_version: String,
    files: BTreeMap<String, String>,
}

fn verify(root: &Path) -> Result<Manifest, Box<dyn std::error::Error>> {
    let root = root.canonicalize()?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("bundle.json"))?)?;
    let platform = if cfg!(windows) { "win32" } else { "darwin" };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    if manifest.platform != platform
        || manifest.arch != arch
        || manifest.node_version != "24.13.0"
        || manifest.bun_version != "1.3.9"
    {
        return Err("bundle runtime/platform mismatch".into());
    }
    let extension = if cfg!(windows) { ".exe" } else { "" };
    for required in [
        format!("runtime/node{extension}"),
        format!("runtime/bun{extension}"),
        "app/dist/host.js".into(),
        "app/dist/main.js".into(),
    ] {
        if !manifest.files.contains_key(&required) {
            return Err(format!("manifest missing {required}").into());
        }
    }
    for (relative, expected) in &manifest.files {
        if Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("unsafe bundle path".into());
        }
        let file = root.join(relative).canonicalize()?;
        if !file.starts_with(&root) {
            return Err("bundle file escapes root".into());
        }
        let mut stream = fs::File::open(file)?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 65536];
        loop {
            let length = stream.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
        }
        if format!("{:x}", digest.finalize()) != *expected {
            return Err(format!("bundle integrity failed: {relative}").into());
        }
    }
    Ok(manifest)
}

fn bundle_root(executable: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = executable.parent().ok_or("launcher has no directory")?;
    if cfg!(target_os = "macos") {
        Ok(directory.join("../Resources/pairing"))
    } else {
        Ok(directory.to_path_buf())
    }
}
fn process_path(path: PathBuf) -> PathBuf {
    // Node's Windows entry loader must receive ordinary absolute paths, not
    // std::fs canonicalize's verbatim prefix combined with URL-style separators.
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path
}

#[cfg(windows)]
fn own_process_tree() -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    // An unnamed process-local job is inherited by all children. The only handle
    // remains in this launcher; OS cleanup kills descendants even on forced exit.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        // Intentionally OS-owned until process exit; do not close while waiting.
    }
    Ok(())
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let root = process_path(bundle_root(&std::env::current_exe()?)?.canonicalize()?);
    let manifest = verify(&root)?;
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    if arguments == [OsString::from("--verify-bundle")] {
        println!(
            "verified {} {} Node {} Bun {}",
            manifest.platform, manifest.arch, manifest.node_version, manifest.bun_version
        );
        return Ok(0);
    }
    #[cfg(windows)]
    own_process_tree()?;
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let mut command = Command::new(root.join(format!("runtime/node{extension}")));
    command
        .arg(root.join("app/dist/host.js"))
        .args(arguments)
        .current_dir(root.join("app"))
        .env(
            "RIEUL_PAIRING_BUN",
            root.join(format!("runtime/bun{extension}")),
        )
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("BUN_OPTIONS")
        .env_remove("NAPI_RS_NATIVE_LIBRARY_PATH");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        return Err(command.exec().into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        Ok(command.status()?.code().unwrap_or(1))
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err("unsupported desktop platform".into())
    }
}
fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Rieul GUI: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_layout_preserves_installer_contract() {
        let path = Path::new("gui").join("rieul-windows-gui.exe");
        if cfg!(windows) {
            assert_eq!(bundle_root(&path).unwrap(), Path::new("gui"));
        }
    }
    #[test]
    fn traversal_is_not_a_normal_component() {
        assert!(Path::new("../runtime/node")
            .components()
            .any(|part| !matches!(part, Component::Normal(_))));
    }
}
