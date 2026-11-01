use super::{
    archive,
    store::Dir,
    transaction::{self, Effects, Installed, Journal, Phase},
    verify::{Identity, Manifest},
    Policy, Version,
};
use anyhow::{bail, Result};
use std::{
    io::Cursor,
    os::unix::fs::{symlink, PermissionsExt},
};
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
fn identity(v: u64) -> Identity {
    Identity {
        version: Version(1, 0, v),
        daemon_sha256: format!("{v:064x}"),
        app_dev: 1,
        app_ino: v,
    }
}
fn tar(entries: &[(&str, u8, &str, u32)]) -> Vec<u8> {
    let mut out = tar::Builder::new(Vec::new());
    for (name, kind, target, mode) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_path(name).unwrap();
        h.set_mode(*mode);
        h.set_entry_type(tar::EntryType::new(*kind));
        if *kind == b'0' {
            h.set_size(target.len() as u64);
        } else {
            h.set_size(0);
            if matches!(*kind, b'1' | b'2') {
                h.set_link_name(target).unwrap();
            }
        }
        h.set_cksum();
        out.append(
            &h,
            if *kind == b'0' {
                target.as_bytes()
            } else {
                b""
            },
        )
        .unwrap();
    }
    out.into_inner().unwrap()
}
#[test]
fn normal_archive_and_internal_framework_link() {
    let (_temp, dir) = fixture();
    archive::extract(
        Cursor::new(tar(&[
            ("Rieul.app/Contents/Versions/A/code", b'0', "test", 0o755),
            ("Rieul.app/Contents/Versions/Current", b'2', "A", 0o777),
        ])),
        &dir,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path.join("Rieul.app/Contents/Versions/Current/code")).unwrap(),
        b"test"
    );
}
#[test]
fn reject_archive_links_special_files_modes_duplicates() {
    let cases = vec![
        vec![("Rieul.app/out", b'2', "../../outside", 0o777)],
        vec![("Rieul.app/out", b'2', "/tmp/outside", 0o777)],
        vec![("Rieul.app/out", b'2', "missing", 0o777)],
        vec![
            ("Rieul.app/a", b'2', "b", 0o777),
            ("Rieul.app/b", b'2', "a", 0o777),
        ],
        vec![("Rieul.app/a", b'1', "Rieul.app/b", 0o644)],
        vec![("Rieul.app/a", b'3', "", 0o644)],
        vec![("Rieul.app/a", b'6', "", 0o644)],
        vec![("Rieul.app/a", b'0', "x", 0o4755)],
        vec![
            ("Rieul.app/a", b'0', "x", 0o644),
            ("Rieul.app/a", b'0', "y", 0o644),
        ],
        vec![
            ("Rieul.app/link", b'2', "real", 0o777),
            ("Rieul.app/link/file", b'0', "x", 0o644),
        ],
        vec![("Other.app/file", b'0', "x", 0o644)],
    ];
    for entries in cases {
        let (_temp, dir) = fixture();
        assert!(
            archive::extract(Cursor::new(tar(&entries)), &dir).is_err(),
            "accepted {entries:?}"
        );
    }
}
#[test]
fn reject_raw_traversal_and_truncated_entry() {
    for name in ["../escape", "/tmp/escape", "Rieul.app/../../escape"] {
        let mut bytes = tar(&[("Rieul.app/ok", b'0', "abc", 0o644)]);
        bytes[..100].fill(0);
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        bytes[148..156].fill(b' ');
        let sum: u32 = bytes[..512].iter().map(|b| *b as u32).sum();
        let checksum = format!("{sum:06o}\0 ");
        bytes[148..156].copy_from_slice(checksum.as_bytes());
        let (_temp, dir) = fixture();
        assert!(archive::extract(Cursor::new(bytes), &dir).is_err());
    }
    let mut bytes = tar(&[("Rieul.app/a", b'0', "abc", 0o644)]);
    bytes.truncate(513);
    let (_temp, dir) = fixture();
    assert!(archive::extract(Cursor::new(bytes), &dir).is_err());
}
#[test]
fn store_refuses_symlink_hardlink_and_writable_records() {
    let (_temp, dir) = fixture();
    std::fs::write(dir.path.join("real"), b"{}").unwrap();
    symlink("real", dir.path.join("link")).unwrap();
    assert!(dir.read_file("link").is_err());
    std::fs::hard_link(dir.path.join("real"), dir.path.join("hard")).unwrap();
    assert!(dir.read_file("real").is_err());
    std::fs::write(dir.path.join("writable"), b"{}").unwrap();
    std::fs::set_permissions(
        dir.path.join("writable"),
        std::fs::Permissions::from_mode(0o666),
    )
    .unwrap();
    assert!(dir.read_file("writable").is_err());
    assert!(dir.create("../escape", 0o600).is_err());
}
#[test]
fn journal_lock_and_stale_temp_are_safe() {
    let (_temp, dir) = fixture();
    let lock = dir.lock().unwrap();
    assert!(dir.lock().is_err());
    drop(lock);
    std::fs::write(dir.path.join("outside"), b"unchanged").unwrap();
    symlink("outside", dir.path.join("record.json.new")).unwrap();
    dir.save(
        "record.json",
        &Policy {
            schema: 1,
            enabled: true,
        },
    )
    .unwrap();
    assert_eq!(
        std::fs::read(dir.path.join("outside")).unwrap(),
        b"unchanged"
    );
    assert!(dir.load::<Policy>("record.json").unwrap().unwrap().allows());
}
#[test]
fn protocol_version_digest_database_gates() {
    let good = Manifest {
        schema: 1,
        version: "1.0.2".into(),
        updater_protocol: 1,
        database_schema: 2,
        daemon_sha256: "a".repeat(64),
    };
    good.validate(Version(1, 0, 2), Version(1, 0, 1), 2)
        .unwrap();
    assert!(good
        .validate(Version(1, 0, 2), Version(1, 0, 2), 2)
        .is_err());
    assert!(good
        .validate(Version(1, 0, 3), Version(1, 0, 1), 2)
        .is_err());
    assert!(good
        .validate(Version(1, 0, 2), Version(1, 0, 1), 3)
        .is_err());
    let mut invalid = good.clone();
    invalid.daemon_sha256 = "G".repeat(64);
    assert!(invalid
        .validate(Version(1, 0, 2), Version(1, 0, 1), 2)
        .is_err());
    assert!(!Policy {
        schema: 2,
        enabled: true
    }
    .allows());
    assert!(!Policy {
        schema: 1,
        enabled: false
    }
    .allows());
}
struct Fake {
    app: Installed,
    service: Installed,
    events: Vec<&'static str>,
    crash: Option<&'static str>,
    healthy: bool,
    parked: bool,
    db: u32,
    valid: bool,
}
impl Default for Fake {
    fn default() -> Self {
        Self {
            app: Installed::Old,
            service: Installed::Old,
            events: vec![],
            crash: None,
            healthy: true,
            parked: false,
            db: 2,
            valid: true,
        }
    }
}
impl Fake {
    fn effect(&mut self, event: &'static str) -> Result<()> {
        self.events.push(event);
        if self.crash == Some(event) {
            self.crash = None;
            bail!("injected crash after {event}");
        }
        Ok(())
    }
}
impl Effects for Fake {
    fn finalized_step(&mut self, step: &str) -> Result<()> {
        match step {
            "result" => self.effect("result"),
            "retired" => self.effect("retired"),
            "cleaned" => self.effect("cleaned"),
            _ => Ok(()),
        }
    }
    fn validate(&mut self, _: &Journal) -> Result<()> {
        if !self.valid {
            bail!("wrong signing identity")
        };
        Ok(())
    }
    fn database_schema(&mut self) -> Result<u32> {
        Ok(self.db)
    }
    fn installed(&mut self) -> Result<(Installed, Installed)> {
        Ok((self.app, self.service))
    }
    fn quiesce(&mut self) -> Result<()> {
        self.effect("stop")
    }
    fn exchange_app(&mut self) -> Result<()> {
        self.app = if self.app == Installed::Old {
            Installed::New
        } else {
            Installed::Old
        };
        self.effect("app")
    }
    fn exchange_service(&mut self) -> Result<()> {
        self.service = if self.service == Installed::Old {
            Installed::New
        } else {
            Installed::Old
        };
        self.effect("service")
    }
    fn start(&mut self, i: &Identity, _: &str) -> Result<()> {
        self.parked = false;
        self.effect(if i.version == Version(1, 0, 2) {
            "start-new"
        } else {
            "start-old"
        })
    }
    fn ready(&mut self, i: &Identity, _: &str) -> Result<bool> {
        Ok(!self.parked && (i.version == Version(1, 0, 1) || self.healthy))
    }
    fn restore_guis(&mut self) -> Result<()> {
        self.effect("gui")
    }
}
#[test]
fn resume_after_each_install_effect_and_commit() {
    for crash in ["stop", "app", "service", "gui"] {
        let (_temp, dir) = fixture();
        transaction::prepare(&dir, identity(1), identity(2)).unwrap();
        let mut effects = Fake {
            crash: Some(crash),
            ..Default::default()
        };
        assert!(transaction::resume(&dir, &mut effects).is_err());
        assert_eq!(
            transaction::resume(&dir, &mut effects).unwrap(),
            Phase::Committed
        );
        assert_eq!(
            (effects.app, effects.service),
            (Installed::New, Installed::New)
        );
        assert_eq!(effects.events.iter().filter(|e| **e == "app").count(), 1);
        assert_eq!(
            effects.events.iter().filter(|e| **e == "service").count(),
            1
        );
    }
}
#[test]
fn failed_health_rolls_back_both_artifacts() {
    let (_temp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    let mut effects = Fake {
        healthy: false,
        ..Default::default()
    };
    assert_eq!(
        transaction::resume(&dir, &mut effects).unwrap(),
        Phase::RolledBack
    );
    assert_eq!(
        (effects.app, effects.service),
        (Installed::Old, Installed::Old)
    );
    assert!(effects.events.contains(&"start-old"));
}
#[test]
fn unknown_identity_wrong_signature_or_schema_has_no_effects() {
    for mut effects in [
        Fake {
            app: Installed::Unknown,
            ..Default::default()
        },
        Fake {
            valid: false,
            ..Default::default()
        },
        Fake {
            db: 3,
            ..Default::default()
        },
    ] {
        let (_temp, dir) = fixture();
        transaction::prepare(&dir, identity(1), identity(2)).unwrap();
        assert!(transaction::resume(&dir, &mut effects).is_err());
        assert!(effects.events.is_empty());
    }
}
#[test]
fn rollback_crash_recovers_by_observed_identity() {
    let (_temp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    let mut j: Journal = dir.load("journal.json").unwrap().unwrap();
    j.phase = Phase::RollingBack;
    dir.save("journal.json", &j).unwrap();
    let mut effects = Fake {
        app: Installed::New,
        service: Installed::New,
        crash: Some("app"),
        ..Default::default()
    };
    assert!(transaction::resume(&dir, &mut effects).is_err());
    assert_eq!(
        transaction::resume(&dir, &mut effects).unwrap(),
        Phase::RolledBack
    );
    assert_eq!(
        (effects.app, effects.service),
        (Installed::Old, Installed::Old)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn native_atomic_exchange_preserves_both_versions_and_is_reversible() {
    let (_temp, dir) = fixture();
    let a = dir.create_dir("a", 0o700).unwrap();
    let b = dir.create_dir("b", 0o700).unwrap();
    std::fs::write(a.path.join("service"), b"old").unwrap();
    std::fs::write(b.path.join("service"), b"new").unwrap();
    a.exchange("service", &b, "service").unwrap();
    assert_eq!(std::fs::read(a.path.join("service")).unwrap(), b"new");
    assert_eq!(std::fs::read(b.path.join("service")).unwrap(), b"old");
    a.exchange("service", &b, "service").unwrap();
    assert_eq!(std::fs::read(a.path.join("service")).unwrap(), b"old");
    let old = a.create_dir("old-app", 0o755).unwrap();
    let new = b.create_dir("new-app", 0o755).unwrap();
    let old_inode = old.identity().unwrap();
    let new_inode = new.identity().unwrap();
    a.exchange("old-app", &b, "new-app").unwrap();
    assert_eq!(a.child("old-app").unwrap().identity().unwrap(), new_inode);
    assert_eq!(b.child("new-app").unwrap().identity().unwrap(), old_inode);
}
#[test]
fn rollback_gui_failure_retries_on_next_recovery() {
    let (_temp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    let mut effects = Fake {
        healthy: false,
        crash: Some("gui"),
        ..Default::default()
    };
    assert!(transaction::resume(&dir, &mut effects).is_err());
    assert_eq!(
        transaction::resume(&dir, &mut effects).unwrap(),
        Phase::RolledBack
    );
    assert_eq!(effects.events.iter().filter(|e| **e == "gui").count(), 2);
}
#[test]
fn independent_transactions_have_distinct_readiness_nonces() {
    let (_a, a) = fixture();
    let (_b, b) = fixture();
    transaction::prepare(&a, identity(1), identity(2)).unwrap();
    transaction::prepare(&b, identity(1), identity(2)).unwrap();
    let ja: Journal = a.load("journal.json").unwrap().unwrap();
    let jb: Journal = b.load("journal.json").unwrap().unwrap();
    assert_ne!(ja.nonce, jb.nonce);
}

struct FixtureSource {
    called: usize,
    broken: bool,
}
impl super::preparation::Source for FixtureSource {
    fn latest(&mut self) -> Result<Version> {
        self.called += 1;
        Ok(Version(1, 0, 2))
    }
    fn download(&mut self, _: Version, stage: &Dir) -> Result<()> {
        self.called += 1;
        std::fs::write(
            stage.path.join("candidate.tar"),
            if self.broken {
                b"broken".to_vec()
            } else {
                tar(&[("Rieul.app/file", b'0', "fixture", 0o644)])
            },
        )?;
        Ok(())
    }
}
#[test]
fn absent_or_disabled_policy_performs_no_network_or_staging() {
    let (_t, dir) = fixture();
    let mut source = FixtureSource {
        called: 0,
        broken: false,
    };
    assert!(
        !super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| panic!(
            "not reached"
        ))
        .unwrap()
    );
    dir.save(
        "policy.json",
        &Policy {
            schema: 1,
            enabled: false,
        },
    )
    .unwrap();
    assert!(
        !super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| panic!(
            "not reached"
        ))
        .unwrap()
    );
    assert_eq!(source.called, 0);
    assert!(!dir.exists("incoming").unwrap());
}
#[test]
fn prepare_retries_orphan_stage_but_never_deletes_pending_transaction() {
    let (_t, dir) = fixture();
    dir.save(
        "policy.json",
        &Policy {
            schema: 1,
            enabled: true,
        },
    )
    .unwrap();
    let mut source = FixtureSource {
        called: 0,
        broken: true,
    };
    assert!(
        super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| Ok(
            identity(2)
        ))
        .is_err()
    );
    source.broken = false;
    assert!(
        super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| Ok(
            identity(2)
        ))
        .unwrap()
    );
    let bytes = std::fs::read(dir.path.join("incoming/candidate.tar")).unwrap();
    assert!(
        super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| Ok(
            identity(2)
        ))
        .is_err()
    );
    assert_eq!(
        std::fs::read(dir.path.join("incoming/candidate.tar")).unwrap(),
        bytes
    );
}
#[test]
fn orphan_cleanup_does_not_follow_symlinks() {
    let (_t, dir) = fixture();
    std::fs::write(dir.path.join("preserve"), b"keep").unwrap();
    let stage = dir.create_dir("incoming", 0o700).unwrap();
    symlink("../preserve", stage.path.join("alias")).unwrap();
    dir.discard_child("incoming").unwrap();
    assert_eq!(std::fs::read(dir.path.join("preserve")).unwrap(), b"keep");
}

#[test]
fn release_contract_builder_roundtrips_through_restricted_extractor() {
    let (_t, dir) = fixture();
    let build = dir.create_dir("build", 0o700).unwrap();
    let stage = dir.create_dir("stage", 0o700).unwrap();
    let app = build.create_dir("Rieul.app", 0o755).unwrap();
    let contents = app.create_dir("Contents", 0o755).unwrap();
    contents.create_dir("Resources", 0o755).unwrap();
    let daemon = contents
        .create_dir("Library", 0o755)
        .unwrap()
        .create_dir("LaunchServices", 0o755)
        .unwrap();
    // Header-only inert fixtures: artifact generation checks CPU architecture;
    // signature verification remains a separate native fixture gate.
    let arm64 = [0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1];
    std::fs::write(daemon.path.join("rieul-macos-system"), arm64).unwrap();
    std::fs::set_permissions(
        daemon.path.join("rieul-macos-system"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let executables = contents.create_dir("MacOS", 0o755).unwrap();
    for name in ["rieul-macos-launcher", "rieul-gui"] {
        std::fs::write(executables.path.join(name), arm64).unwrap();
        std::fs::set_permissions(
            executables.path.join(name),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    std::fs::write(contents.path.join("Info.plist"),br#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.rieul</string><key>CFBundleShortVersionString</key><string>1.0.2</string></dict></plist>"#).unwrap();
    let license = contents
        .path
        .join("Resources/pairing/licenses/fnv-1.0.7/LICENSE-MIT");
    std::fs::create_dir_all(license.parent().unwrap()).unwrap();
    std::fs::write(&license, b"public license fixture").unwrap();
    std::fs::set_permissions(&license, std::fs::Permissions::from_mode(0o644)).unwrap();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/macos/update-artifact.py");
    let output = build.path.join("rieul-macos-update.tar");
    for args in [
        vec!["manifest".as_ref(), app.path.as_os_str()],
        vec![
            "archive".as_ref(),
            app.path.as_os_str(),
            "--output".as_ref(),
            output.as_os_str(),
        ],
    ] {
        let result = std::process::Command::new("python3")
            .arg(&script)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    archive::extract(std::fs::File::open(output).unwrap(), &stage).unwrap();
    let manifest: Manifest = stage
        .child("Rieul.app")
        .unwrap()
        .child("Contents")
        .unwrap()
        .child("Resources")
        .unwrap()
        .load("rieul-update.json")
        .unwrap()
        .unwrap();
    manifest
        .validate(Version(1, 0, 2), Version(1, 0, 1), 2)
        .unwrap();
    assert_eq!(
        manifest.daemon_sha256,
        super::verify::digest(daemon.read_file("rieul-macos-system").unwrap()).unwrap()
    );
    // A privileged builder can read 0640, but the GUI user cannot after a root
    // install. Reject that archive before publication rather than repairing it.
    std::fs::set_permissions(&license, std::fs::Permissions::from_mode(0o640)).unwrap();
    let unreadable = build.path.join("unreadable/rieul-macos-update.tar");
    std::fs::create_dir(unreadable.parent().unwrap()).unwrap();
    let result = std::process::Command::new("python3")
        .arg(&script)
        .arg("archive")
        .arg(&app.path)
        .arg("--output")
        .arg(&unreadable)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("public bundle entry needs mode 644"));
    assert!(!unreadable.exists());
    std::fs::set_permissions(&license, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(
        executables.path.join("rieul-gui"),
        [0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1],
    )
    .unwrap();
    let rejected = build.path.join("intel/rieul-macos-update.tar");
    std::fs::create_dir(rejected.parent().unwrap()).unwrap();
    let result = std::process::Command::new("python3")
        .arg(script)
        .arg("archive")
        .arg(&app.path)
        .arg("--output")
        .arg(&rejected)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("unsupported Mach-O architecture"));
    assert!(!rejected.exists());
}

#[test]
fn app_only_update_preserves_identical_daemon() {
    let (_t, dir) = fixture();
    let old = identity(1);
    let mut new = identity(2);
    new.daemon_sha256 = old.daemon_sha256.clone();
    transaction::prepare(&dir, old, new).unwrap();
    let mut effects = Fake {
        service: Installed::Both,
        ..Default::default()
    };
    assert_eq!(
        transaction::resume(&dir, &mut effects).unwrap(),
        Phase::Committed
    );
    assert!(!effects.events.contains(&"service"));
}

#[test]
fn consecutive_updates_and_finalization_crashes_recover() {
    for point in ["result", "retired", "cleaned"] {
        let (_t, dir) = fixture();
        transaction::prepare(&dir, identity(1), identity(2)).unwrap();
        let mut effects = Fake {
            crash: Some(point),
            ..Default::default()
        };
        assert!(transaction::resume(&dir, &mut effects).is_err());
        assert_eq!(
            transaction::resume(&dir, &mut effects).unwrap(),
            Phase::Committed
        );
        assert!(!dir.exists("journal.json").unwrap());
        transaction::prepare(&dir, identity(2), identity(3)).unwrap();
        let mut second = Fake::default();
        assert_eq!(
            transaction::resume(&dir, &mut second).unwrap(),
            Phase::Committed
        );
        assert!(!dir.exists("journal.json").unwrap());
    }
}

#[test]
fn terminal_reboot_restarts_parked_service_before_retiring_journal() {
    for (phase, target, start) in [
        (Phase::Committed, Installed::New, "start-new"),
        (Phase::RolledBack, Installed::Old, "start-old"),
    ] {
        let (_tmp, dir) = fixture();
        transaction::prepare(&dir, identity(1), identity(2)).unwrap();
        let mut journal: Journal = dir.load("journal.json").unwrap().unwrap();
        journal.phase = phase;
        dir.save("journal.json", &journal).unwrap();
        let mut effects = Fake {
            app: target,
            service: target,
            parked: true,
            ..Default::default()
        };
        assert_eq!(transaction::resume(&dir, &mut effects).unwrap(), phase);
        assert!(!effects.parked);
        let start_pos = effects
            .events
            .iter()
            .position(|event| *event == start)
            .unwrap();
        let gui_pos = effects
            .events
            .iter()
            .position(|event| *event == "gui")
            .unwrap();
        assert!(start_pos < gui_pos);
        assert!(!dir.exists("journal.json").unwrap());
    }
}
#[test]
fn retired_cleanup_precedes_next_prepare_and_cannot_delete_new_transaction() {
    let (_tmp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    dir.create_dir("service-stage", 0o700).unwrap();
    let mut effects = Fake {
        crash: Some("retired"),
        ..Default::default()
    };
    assert!(transaction::resume(&dir, &mut effects).is_err());
    let old: Journal = dir.load("cleanup-pending.json").unwrap().unwrap();
    assert!(dir.exists("service-stage").unwrap());
    transaction::prepare(&dir, identity(2), identity(3)).unwrap();
    assert!(!dir.exists("service-stage").unwrap());
    let incoming = dir.create_dir("incoming", 0o700).unwrap();
    incoming.create("keep", 0o600).unwrap();
    dir.save("cleanup-pending.json", &old).unwrap();
    let _lock = dir.lock().unwrap();
    assert!(transaction::cleanup_pending_locked(&dir).is_err());
    assert!(dir.child("incoming").unwrap().exists("keep").unwrap());
}
#[test]
fn cleanup_rejects_mismatched_terminal_nonce_without_touching_stage() {
    let (_tmp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    let mut effects = Fake {
        crash: Some("retired"),
        ..Default::default()
    };
    assert!(transaction::resume(&dir, &mut effects).is_err());
    let mut pending: Journal = dir.load("cleanup-pending.json").unwrap().unwrap();
    pending.nonce = "f".repeat(64);
    dir.save("cleanup-pending.json", &pending).unwrap();
    dir.create_dir("service-stage", 0o700).unwrap();
    let _lock = dir.lock().unwrap();
    assert!(transaction::cleanup_pending_locked(&dir).is_err());
    assert!(dir.exists("service-stage").unwrap());
}

#[test]
fn dispatch_failures_remain_durable_until_confirmed_retry() {
    for point in ["copy", "signature", "submit"] {
        let (_tmp, dir) = fixture();
        transaction::prepare(&dir, identity(1), identity(2)).unwrap();
        let mut attempts = 0;
        assert!(super::runtime::dispatch_attempt(&dir, false, |_| {
            attempts += 1;
            anyhow::bail!("{point} failed")
        })
        .is_err());
        let j: Journal = dir.load("journal.json").unwrap().unwrap();
        assert!(super::runtime::requires_confirmed_retry(&dir, &j).unwrap());
        let result: super::runtime::WorkerResult = dir.load("worker-result.json").unwrap().unwrap();
        assert_eq!(result.nonce.as_deref(), Some(j.nonce.as_str()));
        assert!(!result.deferred);
        for _ in 0..4 {
            assert!(super::runtime::dispatch_attempt(&dir, false, |_| {
                attempts += 1;
                Ok(())
            })
            .is_err());
        }
        assert_eq!(attempts, 1);
        super::runtime::dispatch_attempt(&dir, true, |_| {
            attempts += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(attempts, 2);
        // Submit succeeded, but only worker acquisition can acknowledge handoff.
        assert!(dir
            .load::<super::runtime::WorkerResult>("worker-result.json")
            .unwrap()
            .unwrap()
            .error
            .is_some());
    }
}
#[test]
fn rolled_back_candidate_is_suppressed_across_discovery_until_confirmed_retry() {
    let (_tmp, dir) = fixture();
    dir.save(
        "policy.json",
        &Policy {
            schema: 1,
            enabled: true,
        },
    )
    .unwrap();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    assert_eq!(
        transaction::resume(
            &dir,
            &mut Fake {
                healthy: false,
                ..Default::default()
            }
        )
        .unwrap(),
        Phase::RolledBack
    );
    let mut source = FixtureSource {
        called: 0,
        broken: false,
    };
    for _ in 0..3 {
        assert!(
            !super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| Ok(
                identity(2)
            ))
            .unwrap()
        );
        assert!(!dir.exists("journal.json").unwrap());
        assert!(!dir.exists("incoming").unwrap());
    }
    assert!(super::preparation::prepare_with_retry(
        &dir,
        identity(1),
        2,
        &mut source,
        |_, _, _, _| Ok(identity(2)),
        true
    )
    .unwrap());
    assert!(super::runtime::dispatch_attempt(&dir, false, |_| panic!(
        "quarantined candidate cannot auto-dispatch"
    ))
    .is_err());
    super::runtime::dispatch_attempt(&dir, true, |_| Ok(())).unwrap();
}
#[test]
fn rollback_suppression_is_bound_to_version_and_digest() {
    let (_tmp, dir) = fixture();
    dir.save(
        "policy.json",
        &Policy {
            schema: 1,
            enabled: true,
        },
    )
    .unwrap();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    transaction::resume(
        &dir,
        &mut Fake {
            healthy: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!super::preparation::rolled_back_candidate(&dir, &identity(3)).unwrap());
    let mut replaced = identity(2);
    replaced.daemon_sha256 = "c".repeat(64);
    assert!(!super::preparation::rolled_back_candidate(&dir, &replaced).unwrap());
    let mut source = FixtureSource {
        called: 0,
        broken: false,
    };
    assert!(
        super::preparation::prepare(&dir, identity(1), 2, &mut source, |_, _, _, _| Ok(replaced))
            .unwrap()
    );
}

#[test]
fn interrupted_dispatch_preserves_write_ahead_failure_marker() {
    let (_tmp, dir) = fixture();
    transaction::prepare(&dir, identity(1), identity(2)).unwrap();
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = super::runtime::dispatch_attempt(&dir, false, |state| {
            assert!(state
                .load::<super::runtime::WorkerResult>("worker-result.json")?
                .unwrap()
                .error
                .is_some());
            panic!("injected dispatch interruption");
        });
    }));
    assert!(crashed.is_err());
    let j: Journal = dir.load("journal.json").unwrap().unwrap();
    assert!(super::runtime::requires_confirmed_retry(&dir, &j).unwrap());
    assert!(
        super::runtime::dispatch_attempt(&dir, false, |_| panic!("must not resubmit")).is_err()
    );
}

#[cfg(target_os = "macos")]
#[test]
fn ambiguous_saved_gui_domain_retains_terminal_journal_until_restore_or_proven_logout() {
    use super::launchd::{Control, Job, JobState};
    struct GuiControl {
        code: i32,
        restored: bool,
    }
    impl Control for GuiControl {
        fn sessions(&mut self) -> Result<Vec<u32>> {
            unreachable!()
        }
        fn inspect(&mut self, _: Job) -> Result<Option<JobState>> {
            unreachable!()
        }
        fn gui_domain(&mut self, uid: u32) -> Result<bool> {
            assert_eq!(uid, 501);
            let text = match self.code {
                125 => "Could not print domain: 125: Domain does not support specified action",
                112 => "Bad request.\nCould not find domain for user gui: 501",
                0 => "existing GUI domain",
                _ => unreachable!(),
            };
            super::launchd::gui_domain_result(uid, self.code, text)
        }
        fn start(&mut self, job: Job) -> Result<()> {
            assert_eq!(job, Job::Gui(501));
            self.restored = true;
            Ok(())
        }
        fn stop(&mut self, _: Job) -> Result<()> {
            unreachable!()
        }
        fn submit_worker(&mut self) -> Result<()> {
            unreachable!()
        }
    }
    struct Recovery<'a> {
        dir: &'a Dir,
        installed: Installed,
        control: GuiControl,
    }
    impl Effects for Recovery<'_> {
        fn validate(&mut self, _: &Journal) -> Result<()> {
            Ok(())
        }
        fn database_schema(&mut self) -> Result<u32> {
            Ok(2)
        }
        fn installed(&mut self) -> Result<(Installed, Installed)> {
            Ok((self.installed, self.installed))
        }
        fn quiesce(&mut self) -> Result<()> {
            unreachable!()
        }
        fn exchange_app(&mut self) -> Result<()> {
            unreachable!()
        }
        fn exchange_service(&mut self) -> Result<()> {
            unreachable!()
        }
        fn start(&mut self, _: &Identity, _: &str) -> Result<()> {
            unreachable!()
        }
        fn ready(&mut self, _: &Identity, _: &str) -> Result<bool> {
            Ok(true)
        }
        fn restore_guis(&mut self) -> Result<()> {
            super::native::restore_saved_guis(self.dir, &mut self.control)
        }
    }
    for phase in [Phase::Committed, Phase::RolledBack] {
        for recovered_code in [0, 112] {
            let (_temp, dir) = fixture();
            transaction::prepare(&dir, identity(1), identity(2)).unwrap();
            let mut journal: Journal = dir.load("journal.json").unwrap().unwrap();
            journal.phase = phase;
            dir.save("journal.json", &journal).unwrap();
            dir.save("gui-sessions.json", &serde_json::json!({"uids":[501]}))
                .unwrap();
            let mut recovery = Recovery {
                dir: &dir,
                installed: if phase == Phase::Committed {
                    Installed::New
                } else {
                    Installed::Old
                },
                control: GuiControl {
                    code: 125,
                    restored: false,
                },
            };
            assert!(
                transaction::resume(&dir, &mut recovery)
                    .unwrap_err()
                    .to_string()
                    .contains("125")
            );
            assert!(dir.exists("journal.json").unwrap());
            assert!(dir.exists("gui-sessions.json").unwrap());
            assert!(!dir.exists("last-result.json").unwrap());
            assert!(!recovery.control.restored);
            recovery.control.code = recovered_code;
            assert_eq!(transaction::resume(&dir, &mut recovery).unwrap(), phase);
            assert_eq!(recovery.control.restored, recovered_code == 0);
            assert!(!dir.exists("journal.json").unwrap());
            assert!(!dir.exists("gui-sessions.json").unwrap());
        }
    }
}
