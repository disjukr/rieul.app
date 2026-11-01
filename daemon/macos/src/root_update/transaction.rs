//! Journal-before-effect coordination. Recovery observes installed identities;
//! journal phase alone never proves a rename or service launch completed.
use super::{store::Dir, verify::Identity, DATABASE_SCHEMA};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) enum Phase {
    Prepared,
    Quiescing,
    Replacing,
    Starting,
    Committed,
    RollingBack,
    RolledBack,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Journal {
    pub schema: u32,
    pub nonce: String,
    pub old: Identity,
    pub new: Identity,
    pub phase: Phase,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Installed {
    Old,
    New,
    /// Service digest is identical in old and new app-only releases.
    Both,
    Unknown,
}
/// Implementations may use only compiled-in paths and service labels. The
/// production adapter and its launchd/multiuser integration are still pending.
/// Signed lifecycle fixtures are required before activating that adapter.
/// `validate` rechecks BOTH rollback and candidate artifacts on every recovery.
/// `quiesce` must be idempotent, stop all owned GUI sessions and the old daemon,
/// and wait until exited. Workers must run independently of the stopped job.
/// Exchanges must be atomic and fsync both parent directories before return.
/// `ready` must be a fresh transaction-bound receipt after DB and server startup.
pub(super) trait Effects {
    fn validate(&mut self, journal: &Journal) -> Result<()>;
    fn database_schema(&mut self) -> Result<u32>;
    fn installed(&mut self) -> Result<(Installed, Installed)>;
    fn quiesce(&mut self) -> Result<()>;
    fn exchange_app(&mut self) -> Result<()>;
    fn exchange_service(&mut self) -> Result<()>;
    fn start(&mut self, identity: &Identity, nonce: &str) -> Result<()>;
    fn ready(&mut self, identity: &Identity, nonce: &str) -> Result<bool>;
    fn restore_guis(&mut self) -> Result<()>;
    fn finalized_step(&mut self, _step: &str) -> Result<()> {
        Ok(())
    }
}
fn save(dir: &Dir, journal: &mut Journal, phase: Phase) -> Result<()> {
    journal.phase = phase;
    dir.save("journal.json", journal)
}
fn known(effects: &mut impl Effects) -> Result<(Installed, Installed)> {
    let installed = effects.installed()?;
    ensure!(
        matches!(installed.0, Installed::Old | Installed::New) && installed.1 != Installed::Unknown,
        "unrecognized installed artifact; manual recovery required"
    );
    Ok(installed)
}
fn at_target(effects: &mut impl Effects, target: Installed, j: &Journal) -> Result<bool> {
    let (app, service) = known(effects)?;
    ensure!(
        service != Installed::Both || j.old.daemon_sha256 == j.new.daemon_sha256,
        "ambiguous service identity"
    );
    Ok(app == target && (service == target || service == Installed::Both))
}
pub(super) fn prepare(dir: &Dir, old: Identity, new: Identity) -> Result<()> {
    let _lock = dir.lock()?;
    prepare_locked(dir, old, new)
}
pub(super) fn prepare_locked(dir: &Dir, old: Identity, new: Identity) -> Result<()> {
    ensure!(
        !dir.exists("journal.json")?,
        "unresolved transaction already exists"
    );
    ensure!(new.version > old.version, "non-increasing update");
    let mut bytes = [0u8; 32];
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
    let nonce = bytes.iter().map(|b| format!("{b:02x}")).collect();
    dir.save(
        "journal.json",
        &Journal {
            schema: 1,
            nonce,
            old,
            new,
            phase: Phase::Prepared,
        },
    )
}
pub(super) fn resume(dir: &Dir, effects: &mut impl Effects) -> Result<Phase> {
    let _lock = dir.lock()?;
    let Some(mut j) = dir.load::<Journal>("journal.json")? else {
        let last: Journal = dir
            .load("last-result.json")?
            .ok_or_else(|| anyhow::anyhow!("no transaction"))?;
        ensure!(
            last.schema == 1 && matches!(last.phase, Phase::Committed | Phase::RolledBack),
            "invalid final result"
        );
        cleanup(dir)?;
        return Ok(last.phase);
    };
    ensure!(
        j.schema == 1
            && j.new.version > j.old.version
            && j.nonce.len() == 64
            && j.nonce.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid journal"
    );
    effects.validate(&j)?;
    ensure!(
        effects.database_schema()? == DATABASE_SCHEMA,
        "database schema changed; manual recovery required"
    );
    known(effects)?;
    if j.phase == Phase::RolledBack {
        ensure!(
            at_target(effects, Installed::Old, &j)?,
            "rolled-back identity changed"
        );
        effects.restore_guis()?;
        finalize(dir, &j, effects)?;
        return Ok(j.phase);
    }
    if j.phase == Phase::Committed {
        ensure!(
            at_target(effects, Installed::New, &j)?,
            "committed identity changed"
        );
        effects.restore_guis()?;
        finalize(dir, &j, effects)?;
        return Ok(j.phase);
    }
    if j.phase == Phase::RollingBack {
        return rollback(dir, &mut j, effects);
    }
    if j.phase == Phase::Prepared {
        save(dir, &mut j, Phase::Quiescing)?;
    }
    effects.quiesce()?;
    // Check again after shutdown, including writes by commands that were active.
    ensure!(
        effects.database_schema()? == DATABASE_SCHEMA,
        "database schema changed during shutdown"
    );
    effects.validate(&j)?;
    save(dir, &mut j, Phase::Replacing)?;
    let (app, service) = known(effects)?;
    if app == Installed::Old {
        effects.exchange_app()?;
    }
    if service == Installed::Old {
        effects.exchange_service()?;
    }
    ensure!(
        at_target(effects, Installed::New, &j)?,
        "replacement identity mismatch"
    );
    save(dir, &mut j, Phase::Starting)?;
    if effects.start(&j.new, &j.nonce).is_ok() && effects.ready(&j.new, &j.nonce).unwrap_or(false) {
        // A candidate changing DB schema violates protocol: never downgrade it.
        ensure!(
            effects.database_schema()? == DATABASE_SCHEMA,
            "candidate changed schema; rollback forbidden"
        );
        save(dir, &mut j, Phase::Committed)?;
        effects.restore_guis()?;
        finalize(dir, &j, effects)?;
        Ok(j.phase)
    } else {
        save(dir, &mut j, Phase::RollingBack)?;
        rollback(dir, &mut j, effects)
    }
}
fn rollback(dir: &Dir, j: &mut Journal, effects: &mut impl Effects) -> Result<Phase> {
    effects.quiesce()?;
    ensure!(
        effects.database_schema()? == DATABASE_SCHEMA,
        "rollback cannot downgrade database"
    );
    effects.validate(j)?;
    let (app, service) = known(effects)?;
    if app == Installed::New {
        effects.exchange_app()?;
    }
    if service == Installed::New {
        effects.exchange_service()?;
    }
    ensure!(
        at_target(effects, Installed::Old, &j)?,
        "rollback identity mismatch"
    );
    effects.start(&j.old, &j.nonce)?;
    ensure!(
        effects.ready(&j.old, &j.nonce)?,
        "old service failed readiness"
    );
    save(dir, j, Phase::RolledBack)?;
    effects.restore_guis()?;
    finalize(dir, j, effects)?;
    Ok(j.phase)
}

fn cleanup(dir: &Dir) -> Result<()> {
    for name in ["incoming", "rollback", "service-stage"] {
        dir.discard_child(name)?;
    }
    for name in ["start-request.json", "ready.json", "gui-sessions.json"] {
        dir.remove(name)?;
    }
    Ok(())
}
fn finalize(dir: &Dir, j: &Journal, effects: &mut impl Effects) -> Result<()> {
    // GUI restoration has succeeded. Preserve durable evidence before retiring
    // intent; after retirement, only private staging is removed, never installed
    // paths. A crash during cleanup is replayed without requiring deleted backups.
    dir.save("last-result.json", j)?;
    effects.finalized_step("result")?;
    dir.remove("journal.json")?;
    effects.finalized_step("retired")?;
    cleanup(dir)?;
    effects.finalized_step("cleaned")
}
