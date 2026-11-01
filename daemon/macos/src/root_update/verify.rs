use super::{store::Dir, Version, APP_ID, DAEMON_ID, DATABASE_SCHEMA, TEAM};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub schema: u32,
    pub version: String,
    pub updater_protocol: u32,
    pub database_schema: u32,
    pub daemon_sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub(super) struct Identity {
    pub version: Version,
    pub daemon_sha256: String,
    pub app_dev: u64,
    pub app_ino: u64,
}
impl Manifest {
    pub fn validate(&self, expected: Version, current: Version, db: u32) -> Result<()> {
        ensure!(
            self.schema == 1 && self.updater_protocol == 1,
            "unsupported updater protocol"
        );
        ensure!(
            Version::parse(&self.version)? == expected && expected > current,
            "version mismatch or non-increasing update"
        );
        ensure!(
            db == DATABASE_SCHEMA && self.database_schema == db,
            "database migration requires interactive release"
        );
        ensure!(
            self.daemon_sha256.len() == 64
                && self
                    .daemon_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid daemon digest"
        );
        Ok(())
    }
}
pub(super) fn digest(mut file: File) -> Result<String> {
    let mut sha = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
pub(super) fn requirement(id: &str) -> String {
    format!("=anchor apple generic and identifier \"{id}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{TEAM}\"")
}
/// Fixed tools, empty environment, bounded runtime and output. No shell.
fn command(stage: &Dir, tool: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    stage.remove("tool.log")?;
    let output = stage.create("tool.log", 0o600)?;
    let mut child = Command::new(tool)
        .args(args)
        .env_clear()
        .env("LC_ALL", "C")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let oversized = stage.read_file("tool.log")?.metadata()?.len() > 65536;
        if Instant::now() >= deadline || oversized {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("verification command exceeded bounds");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    ensure!(status.success(), "artifact verification failed: {tool}");
    let mut bytes = Vec::new();
    stage
        .read_file("tool.log")?
        .take(65537)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "verification output too large");
    Ok(String::from_utf8(bytes)?)
}
fn audit_tree(path: &Path, root: &Path, uid: u32) -> Result<()> {
    let m = std::fs::symlink_metadata(path)?;
    ensure!(m.uid() == uid, "unexpected owner");
    if m.file_type().is_symlink() {
        ensure!(path.canonicalize()?.starts_with(root), "link escapes app");
        return Ok(());
    }
    ensure!(m.mode() & 0o7022 == 0, "unsafe artifact mode");
    ensure!(m.is_file() || m.is_dir(), "special artifact file");
    let fd = File::open(path)?;
    use std::os::fd::AsRawFd;
    super::store::no_acl(fd.as_raw_fd())?;
    if m.is_file() {
        ensure!(m.nlink() == 1, "hardlink in artifact");
    } else {
        for entry in std::fs::read_dir(path)? {
            audit_tree(&entry?.path(), root, uid)?;
        }
    }
    Ok(())
}
/// Must run on the private staged copy, again immediately before replacement.
/// This does not accept a path from a client or release metadata.
pub(super) fn candidate(
    stage: &Dir,
    expected: Version,
    current: Version,
    db: u32,
) -> Result<Identity> {
    let app = stage.child("Rieul.app")?;
    let m = std::fs::symlink_metadata(&app.path)?;
    audit_tree(&app.path, &app.path, m.uid())?;
    let contents = app.child("Contents")?;
    let resources = contents.child("Resources")?;
    let manifest: Manifest = resources
        .load("rieul-update.json")?
        .context("missing signed update manifest")?;
    manifest.validate(expected, current, db)?;
    let daemon_dir = contents.child("Library")?.child("LaunchServices")?;
    let hash = digest(daemon_dir.read_file("rieul-macos-system")?)?;
    ensure!(hash == manifest.daemon_sha256, "daemon digest mismatch");
    let app_req = requirement(APP_ID);
    let daemon_req = requirement(DAEMON_ID);
    let daemon = daemon_dir.path.join("rieul-macos-system");
    for (path, req) in [(&app.path, &app_req), (&daemon, &daemon_req)] {
        command(
            stage,
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                "-R".as_ref(),
                req.as_ref(),
                path.as_os_str(),
            ],
        )?;
    }
    let info = contents.path.join("Info.plist");
    let version = command(
        stage,
        "/usr/bin/plutil",
        &[
            "-extract".as_ref(),
            "CFBundleShortVersionString".as_ref(),
            "raw".as_ref(),
            "-o".as_ref(),
            "-".as_ref(),
            info.as_os_str(),
        ],
    )?;
    ensure!(
        version.trim() == manifest.version,
        "signed bundle version differs from manifest"
    );
    let assessment = command(
        stage,
        "/usr/sbin/spctl",
        &[
            "--assess".as_ref(),
            "--type".as_ref(),
            "execute".as_ref(),
            "--verbose=4".as_ref(),
            app.path.as_os_str(),
        ],
    )?;
    ensure!(
        assessment
            .lines()
            .any(|l| l == "source=Notarized Developer ID"),
        "notarization not proven"
    );
    let (app_dev, app_ino) = app.identity()?;
    Ok(Identity {
        version: expected,
        daemon_sha256: hash,
        app_dev,
        app_ino,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, Dir) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = Dir::open(
            &temp.path().canonicalize().unwrap(),
            unsafe { libc::geteuid() },
            false,
        )
        .unwrap();
        (temp, dir)
    }
    #[test]
    fn digest_is_sha256_and_manifest_is_strict() {
        let (_t, dir) = fixture();
        std::fs::write(dir.path.join("data"), b"abc").unwrap();
        assert_eq!(
            digest(dir.read_file("data").unwrap()).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(serde_json::from_value::<Manifest>(serde_json::json!({"schema":1,"version":"1.2.3","updater_protocol":1,"database_schema":2,"daemon_sha256":"a".repeat(64),"command":"evil"})).is_err());
    }
    #[test]
    fn artifact_audit_rejects_writable_executable_and_external_link() {
        let (_t, dir) = fixture();
        let app = dir.create_dir("Rieul.app", 0o755).unwrap();
        let code = app.path.join("code");
        std::fs::write(&code, b"code").unwrap();
        std::fs::set_permissions(&code, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(audit_tree(&app.path, &app.path, unsafe { libc::geteuid() }).is_err());
        std::fs::set_permissions(&code, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("/bin/sh", app.path.join("escape")).unwrap();
        assert!(audit_tree(&app.path, &app.path, unsafe { libc::geteuid() }).is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "Read-only macOS Security framework check requires an unsandboxed verifier"]
    fn real_signature_checker_accepts_platform_signature_and_rejects_wrong_identity_and_tampering()
    {
        let (_t, dir) = fixture();
        command(
            &dir,
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--strict".as_ref(),
                "-R".as_ref(),
                "=anchor apple".as_ref(),
                "/usr/bin/true".as_ref(),
            ],
        )
        .unwrap();
        assert!(command(
            &dir,
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--strict".as_ref(),
                "-R".as_ref(),
                requirement(DAEMON_ID).as_ref(),
                "/usr/bin/true".as_ref()
            ]
        )
        .is_err());
        let copy = dir.path.join("tampered");
        std::fs::copy("/usr/bin/true", &copy).unwrap();
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&copy)
            .unwrap();
        f.write_all(b"tamper").unwrap();
        f.sync_all().unwrap();
        assert!(command(
            &dir,
            "/usr/bin/codesign",
            &["--verify".as_ref(), "--strict".as_ref(), copy.as_os_str()]
        )
        .is_err());
    }
}
