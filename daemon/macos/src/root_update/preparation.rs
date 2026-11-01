//! Download/verify without disrupting the running service. Caller holds the
//! private root state lock until a fully validated journal is durable.
use super::{
    archive, source,
    store::Dir,
    transaction,
    verify::{self, Identity},
    Policy, Version,
};
use anyhow::{ensure, Result};
use rusqlite::{Connection, OpenFlags};

pub(super) trait Source {
    fn latest(&mut self) -> Result<Version>;
    fn download(&mut self, version: Version, stage: &Dir) -> Result<()>;
}
pub(super) struct Official;
impl Source for Official {
    fn latest(&mut self) -> Result<Version> {
        source::latest()
    }
    fn download(&mut self, version: Version, stage: &Dir) -> Result<()> {
        source::download(version, stage)
    }
}
pub(super) fn database_schema(data: &Dir) -> Result<u32> {
    // Protected parent and no-follow check precede SQLite's read-only open.
    // Existing WAL/SHM remain with the live daemon; never copy just the main DB.
    let _db = data.read_file("daemon-state.sqlite3")?;
    for name in ["daemon-state.sqlite3-wal", "daemon-state.sqlite3-shm"] {
        if data.exists(name)? {
            data.read_file(name)?;
        }
    }
    let db = Connection::open_with_flags(
        data.path.join("daemon-state.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    Ok(db.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}
pub(super) fn prepare(
    state: &Dir,
    old: Identity,
    db: u32,
    source: &mut impl Source,
    validate: impl FnOnce(&Dir, Version, Version, u32) -> Result<Identity>,
) -> Result<bool> {
    state.require_private()?;
    let _lock = state.lock()?;
    let Some(policy) = state.load::<Policy>("policy.json")? else {
        return Ok(false);
    };
    use std::os::unix::fs::MetadataExt;
    ensure!(
        state.read_file("policy.json")?.metadata()?.mode() & 0o077 == 0,
        "policy must be root-private"
    );
    if !policy.allows() {
        return Ok(false);
    }
    ensure!(
        !state.exists("journal.json")?,
        "recover pending transaction before discovery"
    );
    let version = source.latest()?;
    if version <= old.version {
        return Ok(false);
    }
    // A crash before journal creation has no installation effects. Discard only
    // the fixed orphan staging directory; never a journal's rollback artifact.
    state.discard_child("incoming")?;
    let stage = state.create_dir("incoming", 0o700)?;
    source.download(version, &stage)?;
    archive::extract(stage.read_file("candidate.tar")?, &stage)?;
    let new = validate(&stage, version, old.version, db)?;
    ensure!(new.version == version, "verifier returned wrong version");
    transaction::prepare_locked(state, old, new)?;
    Ok(true)
}
/// Intended daemon-internal entry point, not exposed via RPC/CLI or called by
/// production startup until lifecycle/migration integration is reviewed.
pub(super) fn prepare_official(old: Identity) -> Result<bool> {
    ensure!(unsafe { libc::geteuid() } == 0, "root service required");
    let state = Dir::open(std::path::Path::new(super::STATE), 0, true)?;
    let data = Dir::open(
        std::path::Path::new("/Library/Application Support/rieul"),
        0,
        true,
    )?;
    prepare(
        &state,
        old,
        database_schema(&data)?,
        &mut Official,
        verify::candidate,
    )
}
