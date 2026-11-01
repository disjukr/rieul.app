//! Native payload format v2. Public executable/installer identities remain unchanged.
use anyhow::{Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path, PathBuf},
};
pub const GPUI_REVISION: &str = "025d2a06ee7920777bf4947f11e46a1f52e62cbb";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    implementation: String,
    platform: String,
    arch: String,
    gpui_revision: String,
    executable_sha256: String,
    files: BTreeMap<String, String>,
}
pub fn root(executable: &Path) -> Result<PathBuf> {
    let parent = executable
        .parent()
        .ok_or_else(|| anyhow::anyhow!("GUI executable has no parent"))?;
    Ok(if cfg!(target_os = "macos") {
        parent.join("../Resources/pairing")
    } else {
        parent.to_path_buf()
    })
}
fn hash(path: &Path) -> Result<String> {
    let mut stream = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = stream.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn verify(executable: &Path) -> Result<PathBuf> {
    let root = root(executable)?.canonicalize()?;
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(root.join("bundle.json"))?)?;
    ensure!(
        manifest.schema_version == 2
            && manifest.implementation == "rust-gpui"
            && manifest.gpui_revision == GPUI_REVISION,
        "native GUI manifest version mismatch"
    );
    ensure!(
        manifest.platform == if cfg!(windows) { "win32" } else { "darwin" }
            && manifest.arch
                == if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    "x64"
                },
        "native GUI target mismatch"
    );
    ensure!(
        hash(executable)? == manifest.executable_sha256,
        "GUI executable integrity failed"
    );
    for required in [
        "assets/tray.png",
        "assets/icon.ico",
        "licenses/dependencies.json",
    ] {
        ensure!(
            manifest.files.contains_key(required),
            "manifest missing {required}"
        );
    }
    for (relative, expected) in manifest.files {
        ensure!(
            !relative.is_empty()
                && !relative.contains('\\')
                && Path::new(&relative)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "unsafe bundle path"
        );
        let file = root.join(&relative).canonicalize()?;
        ensure!(file.starts_with(&root), "bundle file escapes root");
        ensure!(
            hash(&file)? == expected,
            "bundle integrity failed: {relative}"
        );
    }
    Ok(root)
}
