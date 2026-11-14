//! One narrowly scoped administrative repair for schema-1 journals. A device
//! number is not a persistent volume identifier. Legacy records do not have a
//! volume UUID to compare across boots, so this is not an automatic rebind.
use super::transaction::{Journal, Phase};
use anyhow::{Result, ensure};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    dev: u64,
    ino: u64,
    volume: [u8; 16],
}

fn verify_unswapped(
    j: &Journal,
    installed: Entry,
    staged: Entry,
    parents: [(u64, [u8; 16]); 2],
    old_digest: &str,
) -> Result<()> {
    ensure!(
        j.schema == 1
            && j.phase == Phase::Prepared
            && j.new.version > j.old.version
            && j.nonce.len() == 64
            && j.nonce.bytes().all(|b| b.is_ascii_hexdigit()),
        "expected a valid schema-1 Prepared transaction"
    );
    ensure!(
        j.old.app_dev == j.new.app_dev
            && installed.ino == j.old.app_ino
            && staged.ino == j.new.app_ino
            && installed.ino != staged.ino,
        "recorded app entries do not match the pre-swap paths"
    );
    ensure!(
        installed.dev == staged.dev
            && installed.volume != [0; 16]
            && staged.volume == installed.volume
            && parents == [(installed.dev, installed.volume); 2],
        "app entries and their exchange parents must be on one current volume"
    );
    ensure!(
        old_digest == j.old.daemon_sha256,
        "protected runtime is not the old runtime"
    );
    ensure!(
        installed.dev != j.old.app_dev,
        "both device numbers must differ from the recorded device"
    );
    Ok(())
}

fn failed_attempt_matches(
    expected_nonce: &str,
    nonce: Option<&str>,
    phase: &str,
    deferred: bool,
    error: Option<&str>,
) -> bool {
    nonce == Some(expected_nonce)
        && phase == "failed"
        && !deferred
        && error == Some("unknown app entry")
}

#[cfg(target_os = "macos")]
pub(super) fn volume_uuid(fd: &std::fs::File) -> Result<[u8; 16]> {
    use std::os::fd::AsRawFd;
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    // One fixed-size UUID follows the four-byte Darwin attribute buffer size.
    let mut buf = [0u8; 20];
    let result = unsafe {
        libc::fgetattrlist(
            fd.as_raw_fd(),
            (&mut attributes as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    ensure!(
        u32::from_ne_bytes(buf[..4].try_into()?) as usize == buf.len(),
        "unexpected volume UUID result size"
    );
    Ok(buf[4..].try_into()?)
}

#[cfg(target_os = "macos")]
fn file_entry(file: &std::fs::File) -> Result<Entry> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok(Entry {
        dev: m.dev(),
        ino: m.ino(),
        volume: volume_uuid(file)?,
    })
}

#[cfg(target_os = "macos")]
pub fn repair() -> Result<()> {
    use super::{
        DAEMON_ID, DATABASE_SCHEMA, SERVICE, STATE, Version,
        destination::AppDestination,
        launchd::{self, Control, Job},
        preparation,
        runtime::WorkerResult,
        store::Dir,
        verify,
    };
    use anyhow::Context;
    use serde::Deserialize;
    use std::path::Path;

    ensure!(
        unsafe { libc::geteuid() } == 0,
        "repair requires administrator execution"
    );
    let state = Dir::open(Path::new(STATE), 0, true)?;
    state.require_private()?;
    let _lock = state.lock()?;
    let mut control = launchd::Native { state: &state };
    ensure!(
        control
            .inspect(Job::Worker)?
            .and_then(|job| job.pid)
            .is_none(),
        "update worker still active"
    );
    let j: Journal = state.load("journal.json")?.context("no pending journal")?;
    let previous: WorkerResult = state
        .load("worker-result.json")?
        .context("no failed attempt record")?;
    ensure!(
        failed_attempt_matches(
            &j.nonce,
            previous.nonce.as_deref(),
            &previous.phase,
            previous.deferred,
            previous.error.as_deref(),
        ),
        "worker result does not authorize this specific recovery"
    );
    for name in [
        "migration.json",
        "cleanup-pending.json",
        "rollback",
        "drain-request.json",
        "drain-response.json",
        "gui-sessions.json",
        "service-stage-tmp",
    ] {
        ensure!(!state.exists(name)?, "unexpected recovery evidence: {name}");
    }

    let data = Dir::open(Path::new(super::gate::DATA), 0, true)?;
    let service = Dir::open(Path::new(SERVICE).parent().unwrap(), 0, true)?;
    let app = AppDestination::open()?;
    let incoming = state.child("incoming")?;
    let staged = incoming.child("Rieul.app")?;
    let app_fd = app.open_entry()?;
    let a = file_entry(&app_fd)?;
    let (dev, ino) = staged.identity()?;
    let b = Entry {
        dev,
        ino,
        volume: staged.repair_volume()?.1,
    };
    let parents = [app.repair_volume()?, incoming.repair_volume()?];
    let old_digest = verify::digest(service.read_file("rieul-macos-system")?)?;
    verify_unswapped(&j, a, b, parents, &old_digest)?;
    super::migration::check_old_readiness(&state, &j.nonce, &old_digest)?;

    ensure!(
        preparation::database_schema(&data)? == DATABASE_SCHEMA,
        "database schema changed"
    );
    launchd::checked(
        &state,
        "/usr/bin/codesign",
        &[
            "--verify",
            "--strict",
            "-R",
            &verify::requirement(DAEMON_ID),
            SERVICE,
        ],
    )?;
    if state.exists("service-stage")? {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Binding {
            nonce: String,
        }
        let staged_service = state.child("service-stage")?;
        let binding: Binding = staged_service
            .load("transaction.json")?
            .context("missing staged runtime binding")?;
        ensure!(
            binding.nonce == j.nonce
                && verify::digest(staged_service.read_file("rieul-macos-system")?)?
                    == j.new.daemon_sha256,
            "protected staged runtime does not match the pending candidate"
        );
    }

    // Never run signature tools against the public entry. Create unrelated
    // disposable copies under a protected parent and leave original app trees
    // untouched. The temp directory is removed even if checks fail.
    let tmp = tempfile::Builder::new()
        .prefix("repair-verify-")
        .tempdir_in(&state.path)?;
    let scratch = Dir::open(tmp.path(), 0, true)?;
    let old_copy = scratch.create_dir("installed", 0o700)?;
    let new_copy = scratch.create_dir("staged", 0o700)?;
    ensure!(
        app.snapshot_entry(app_fd.try_clone()?, &old_copy)? == (a.dev, a.ino),
        "public app changed during snapshot"
    );
    staged.copy_contents(&new_copy.create_dir("Rieul.app", 0o755)?)?;
    for (copy, expected) in [(&old_copy, &j.old), (&new_copy, &j.new)] {
        let checked = verify::candidate(copy, expected.version, Version(0, 0, 0), DATABASE_SCHEMA)?;
        ensure!(
            checked.version == expected.version && checked.daemon_sha256 == expected.daemon_sha256,
            "signed app does not match journal"
        );
    }

    let fresh_staged = state.child("incoming")?;
    let fresh_app = fresh_staged.child("Rieul.app")?;
    ensure!(
        file_entry(&app_fd)? == a
            && file_entry(&app.open_entry()?)? == a
            && fresh_app.identity()? == (b.dev, b.ino)
            && fresh_app.repair_volume()? == (b.dev, b.volume)
            && [app.repair_volume()?, fresh_staged.repair_volume()?] == parents
            && verify::digest(service.read_file("rieul-macos-system")?)? == old_digest
            && preparation::database_schema(&data)? == DATABASE_SCHEMA,
        "update paths changed during repair verification"
    );
    // Archive verified pre-swap state, never a rollback runtime. The journal
    // remains active until the last atomic rename. If interrupted before that
    // point, the ordinary updater can recreate a missing candidate stage.
    // A subsequent Check sees no journal and can discover the latest release.
    let journal_archive = format!("retired-device-journal-{}.json", j.nonce);
    ensure!(
        !state.exists(&journal_archive)?,
        "journal archive already exists"
    );
    if state.exists("service-stage")? {
        state.publish_dir(
            "service-stage",
            &format!("retired-device-stage-{}", j.nonce),
        )?;
    }
    state.rename_file("journal.json", &journal_archive)?;
    println!("Stale update retired. Use Check for Updates in Rieul to find the latest release.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root_update::{Version, verify::Identity};

    const VOLUME: [u8; 16] = [1; 16];
    const PARENTS: [(u64, [u8; 16]); 2] = [(42, VOLUME); 2];
    fn entry(ino: u64) -> Entry {
        Entry {
            dev: 42,
            ino,
            volume: VOLUME,
        }
    }
    fn journal() -> Journal {
        Journal {
            schema: 1,
            phase: Phase::Prepared,
            nonce: "a".repeat(64),
            old: Identity {
                version: Version(0, 6, 23),
                daemon_sha256: "a".repeat(64),
                app_dev: 7,
                app_ino: 100,
            },
            new: Identity {
                version: Version(0, 6, 24),
                daemon_sha256: "b".repeat(64),
                app_dev: 7,
                app_ino: 101,
            },
        }
    }

    #[test]
    fn accepts_only_device_number_churn_without_rewriting_schema() {
        let j = journal();
        assert!(
            verify_unswapped(&j, entry(100), entry(101), PARENTS, &j.old.daemon_sha256).is_ok()
        );
        let mut unchanged = j.clone();
        unchanged.old.app_dev = 42;
        unchanged.new.app_dev = 42;
        assert!(
            verify_unswapped(
                &unchanged,
                entry(100),
                entry(101),
                PARENTS,
                &unchanged.old.daemon_sha256
            )
            .is_err()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_volume_uuid_reads_nonzero_uuid_from_directory_descriptors() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("child");
        std::fs::create_dir(&nested).unwrap();
        let parent = std::fs::File::open(root.path()).unwrap();
        let child = std::fs::File::open(nested).unwrap();
        let parent = volume_uuid(&parent).unwrap();
        assert_ne!(parent, [0; 16]);
        assert_eq!(parent, volume_uuid(&child).unwrap());
    }

    #[test]
    fn accepts_only_the_exact_failed_worker_attempt() {
        let error = Some("unknown app entry");
        assert!(failed_attempt_matches(
            "n",
            Some("n"),
            "failed",
            false,
            error
        ));
        assert!(!failed_attempt_matches(
            "n",
            Some("m"),
            "failed",
            false,
            error
        ));
        assert!(!failed_attempt_matches(
            "n",
            Some("n"),
            "accepted",
            false,
            error
        ));
        assert!(!failed_attempt_matches(
            "n",
            Some("n"),
            "failed",
            true,
            error
        ));
        assert!(!failed_attempt_matches(
            "n",
            Some("n"),
            "failed",
            false,
            None
        ));
    }

    #[test]
    fn rejects_swapped_or_changed_entries_volume_phase_and_protected_runtime() {
        let mut j = journal();
        let hash = j.old.daemon_sha256.clone();
        assert!(verify_unswapped(&j, entry(101), entry(100), PARENTS, &hash).is_err());
        assert!(verify_unswapped(&j, entry(100), entry(102), PARENTS, &hash).is_err());
        assert!(verify_unswapped(&j, entry(102), entry(101), PARENTS, &hash).is_err());
        assert!(
            verify_unswapped(
                &j,
                entry(100),
                Entry {
                    volume: [2; 16],
                    ..entry(101)
                },
                PARENTS,
                &hash
            )
            .is_err()
        );
        assert!(
            verify_unswapped(
                &j,
                entry(100),
                entry(101),
                [(42, VOLUME), (42, [2; 16])],
                &hash
            )
            .is_err()
        );
        assert!(
            verify_unswapped(&j, entry(100), entry(101), PARENTS, &j.new.daemon_sha256).is_err()
        );
        j.phase = Phase::Quiescing;
        assert!(verify_unswapped(&j, entry(100), entry(101), PARENTS, &hash).is_err());
        j.phase = Phase::Prepared;
        j.new.app_dev = 42;
        assert!(verify_unswapped(&j, entry(100), entry(101), PARENTS, &hash).is_err());
    }
}
