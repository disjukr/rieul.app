use super::store::Dir;
use anyhow::{bail, ensure, Result};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Component, Path},
};
const MAX_FILES: usize = 100_000;
pub(super) const MAX_ARCHIVE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILE: u64 = 512 * 1024 * 1024;
fn parts(path: &Path) -> Result<Vec<String>> {
    let text = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("non-UTF8 archive path"))?;
    ensure!(
        text.len() <= 1024 && !text.contains('\\') && !text.chars().any(char::is_control),
        "invalid archive name"
    );
    let result = path
        .components()
        .map(|p| match p {
            Component::Normal(s) => Ok(s.to_str().unwrap().to_string()),
            _ => bail!("archive traversal"),
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(result.len() <= 64, "archive path too deep");
    ensure!(
        result.first().map(String::as_str) == Some("Rieul.app"),
        "unexpected archive root"
    );
    Ok(result)
}
fn parent(root: &Dir, parts: &[String]) -> Result<Dir> {
    let mut dir = root.child(&parts[0])?;
    for p in &parts[1..parts.len() - 1] {
        dir = dir.create_dir(p, 0o755)?;
    }
    Ok(dir)
}
/// Never invokes tar/ditto/unpack. No archive ownership, xattrs, ACLs or suid
/// metadata is honored. Links are deferred until all regular files exist.
pub(super) fn extract(reader: impl Read, root: &Dir) -> Result<()> {
    root.require_private()?;
    ensure!(!root.exists("Rieul.app")?, "staging app already exists");
    root.create_dir("Rieul.app", 0o755)?;
    let mut archive = tar::Archive::new(reader.take(MAX_ARCHIVE + 1));
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    let mut allocated = HashSet::new();
    let mut total = 0u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let names = parts(&path)?;
        for n in 1..=names.len() {
            allocated.insert(names[..n].to_vec());
        }
        ensure!(
            allocated.len() <= MAX_FILES,
            "too many explicit or implicit entries"
        );
        ensure!(
            seen.insert(path.clone()) && seen.len() <= MAX_FILES,
            "duplicate entry or too many files"
        );
        if let Some(extensions) = entry.pax_extensions()? {
            for ext in extensions {
                let ext = ext?;
                ensure!(
                    ["path", "linkpath"].contains(&ext.key()?),
                    "unsupported extended archive metadata"
                );
            }
        }
        let kind = entry.header().entry_type();
        let mode = entry.header().mode()?;
        ensure!(mode & 0o7000 == 0, "special mode bits forbidden");
        if names.len() == 1 {
            ensure!(kind.is_dir(), "archive root is not a directory");
            continue;
        }
        let dir = parent(root, &names)?;
        let name = names.last().unwrap();
        if kind.is_dir() {
            dir.create_dir(name, 0o755)?;
        } else if kind.is_file() {
            let size = entry.size();
            total = total
                .checked_add(size)
                .ok_or_else(|| anyhow::anyhow!("size overflow"))?;
            ensure!(
                size <= MAX_FILE && total <= MAX_ARCHIVE,
                "archive exceeds resource limits"
            );
            let mut out = dir.create(name, if mode & 0o111 != 0 { 0o755 } else { 0o644 })?;
            ensure!(
                std::io::copy(&mut entry, &mut out)? == size,
                "truncated archive entry"
            );
            out.flush()?;
            out.sync_all()?;
            dir.sync()?;
        } else if kind.is_symlink() {
            let target = entry
                .link_name()?
                .ok_or_else(|| anyhow::anyhow!("missing symlink target"))?
                .into_owned();
            ensure!(!target.is_absolute(), "absolute symlink target");
            let mut resolved = names[..names.len() - 1].to_vec();
            for part in target.components() {
                match part {
                    Component::Normal(s) => resolved.push(
                        s.to_str()
                            .ok_or_else(|| anyhow::anyhow!("non-UTF8 link"))?
                            .to_owned(),
                    ),
                    Component::CurDir => {}
                    Component::ParentDir => {
                        ensure!(resolved.len() > 1, "escaping symlink");
                        resolved.pop();
                    }
                    _ => bail!("invalid symlink"),
                }
            }
            links.push((names, target));
        } else {
            bail!("hardlinks, sparse entries and special files are forbidden");
        }
    }
    // No file can be extracted through an archive-provided symlink.
    for (names, target) in &links {
        parent(root, names)?.symlink(names.last().unwrap(), target)?;
    }
    let canonical = root.path.join("Rieul.app").canonicalize()?;
    for (names, _) in &links {
        let path = names.iter().fold(root.path.clone(), |p, n| p.join(n));
        let resolved = path.canonicalize()?;
        ensure!(
            resolved.starts_with(&canonical),
            "symlink chain escapes staging"
        );
    }
    root.sync()?;
    Ok(())
}
