//! Read-only preflight for the macOS app-bundle update migration (#45).
//!
//! This deliberately does not install, register, download, or repair anything.
//! A positive signature check here is diagnostic, not an authorization token:
//! the eventual installer must independently validate its private staged copy.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateBlocker {
    UntrustedBundle,
    LegacyServiceRegistration,
    ProtectedAppBundle,
    UpdaterNotConfigured,
}

impl fmt::Display for UpdateBlocker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UntrustedBundle => "The installed app or embedded daemon could not be verified (signature, path, or verification environment). Do not migrate automatically.",
            Self::LegacyServiceRegistration => "Legacy launchd registration is present. Migrate services before changing app ownership; initial administrator authorization is required.",
            Self::ProtectedAppBundle => "The app is root-owned or not writable by this user. Routine bundle replacement may require administrator authorization.",
            Self::UpdaterNotConfigured => "Automatic updates are not implemented in this build. Continue using the signed installer until the service migration and updater are validated.",
        })
    }
}

#[derive(Debug)]
pub struct UpdateStatus {
    pub blockers: Vec<UpdateBlocker>,
}

fn assess(trusted_bundle: bool, legacy_jobs: bool, user_writable: bool) -> UpdateStatus {
    let mut blockers = Vec::new();
    if !trusted_bundle {
        blockers.push(UpdateBlocker::UntrustedBundle);
    }
    if legacy_jobs {
        blockers.push(UpdateBlocker::LegacyServiceRegistration);
    }
    if !user_writable {
        blockers.push(UpdateBlocker::ProtectedAppBundle);
    }
    // Do not infer operational readiness from ownership or valid signatures.
    // SMAppService approval, lifecycle coordination, and Sparkle are separate gates.
    blockers.push(UpdateBlocker::UpdaterNotConfigured);
    UpdateStatus { blockers }
}

#[cfg(target_os = "macos")]
pub fn installed_update_status() -> std::io::Result<UpdateStatus> {
    use std::fs;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;
    use std::process::Command;

    const APP: &str = "/Applications/Rieul.app";
    const DAEMON: &str =
        "/Applications/Rieul.app/Contents/Library/LaunchServices/rieul-macos-system";
    // These are product identities, not values read from the candidate bundle.
    const APP_REQUIREMENT: &str = "anchor apple generic and identifier \"app.rieul\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"D379GLRLPV\"";
    const DAEMON_REQUIREMENT: &str = "anchor apple generic and identifier \"rieul-macos-system\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"D379GLRLPV\"";

    let metadata = fs::symlink_metadata(APP)?;
    let paths_valid = metadata.is_dir()
        && !has_symlink_component(Path::new(APP))?
        && !has_symlink_component(Path::new(DAEMON))?
        && fs::symlink_metadata(DAEMON)?.is_file();
    let trusted = paths_valid
        && signature_matches(APP, APP_REQUIREMENT)?
        && signature_matches(DAEMON, DAEMON_REQUIREMENT)?;

    let mut legacy_jobs = false;
    for (directory, domain, label) in [
        ("LaunchDaemons", "system", "app.rieul.daemon"),
        ("LaunchDaemons", "system", "app.rieul.system"),
        ("LaunchAgents", "", "app.rieul.gui"),
        ("LaunchAgents", "", "app.rieul.user"),
    ] {
        // A dangling symlink is still a legacy registration requiring attention.
        match fs::symlink_metadata(format!("/Library/{directory}/{label}.plist")) {
            Ok(_) => legacy_jobs = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // A removed plist does not unload an already bootstrapped root job.
        if domain == "system"
            && Command::new("/bin/launchctl")
                .args(["print", &format!("{domain}/{label}")])
                .output()?
                .status
                .success()
        {
            legacy_jobs = true;
        }
    }
    // access(2) includes ACL checks; root ownership is a migration gate even
    // when an administrator happens to be able to rename the enclosing entry.
    let user_writable = metadata.uid() != 0
        && Command::new("/bin/test")
            .args(["-w", APP])
            .status()?
            .success()
        && Command::new("/bin/test")
            .args(["-w", "/Applications"])
            .status()?
            .success();
    Ok(assess(trusted, legacy_jobs, user_writable))
}

#[cfg(target_os = "macos")]
fn signature_matches(path: &str, requirement: &str) -> std::io::Result<bool> {
    Ok(std::process::Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "--deep",
            "--strict",
            "-R",
            &format!("={requirement}"),
            path,
        ])
        .output()?
        .status
        .success())
}

#[cfg(target_os = "macos")]
fn has_symlink_component(path: &std::path::Path) -> std::io::Result<bool> {
    for component in path.ancestors() {
        if std::fs::symlink_metadata(component)?
            .file_type()
            .is_symlink()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn symlinked_parent_is_rejected_even_when_leaf_is_regular() {
        let temporary = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "rieul-update-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&temporary).unwrap();
        let real = temporary.join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("daemon"), b"fixture").unwrap();
        let alias = temporary.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let direct_result = has_symlink_component(&real.join("daemon"));
        let aliased_result = has_symlink_component(&alias.join("daemon"));
        std::fs::remove_dir_all(&temporary).unwrap();
        assert!(!direct_result.unwrap());
        assert!(aliased_result.unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn platform_binary_cannot_impersonate_rieul() {
        assert!(!signature_matches("/usr/bin/true", "anchor apple generic and identifier \"app.rieul\" and certificate leaf[subject.OU] = \"D379GLRLPV\"").unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn requirement_is_parsed_as_text_not_a_filename() {
        // The platform binary's own designated requirement provides a real
        // positive verification without creating keys or modifying the OS.
        let output = std::process::Command::new("/usr/bin/codesign")
            .args(["-d", "-r-", "/usr/bin/true"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let requirement = combined
            .lines()
            .find_map(|line| line.strip_prefix("designated => "))
            .unwrap();
        assert!(signature_matches("/usr/bin/true", requirement).unwrap());
    }

    #[test]
    fn root_owned_legacy_install_requires_migration() {
        assert_eq!(
            assess(true, true, false).blockers,
            vec![
                UpdateBlocker::LegacyServiceRegistration,
                UpdateBlocker::ProtectedAppBundle,
                UpdateBlocker::UpdaterNotConfigured,
            ]
        );
    }

    #[test]
    fn changing_ownership_does_not_make_legacy_root_job_safe() {
        assert!(assess(true, true, true)
            .blockers
            .contains(&UpdateBlocker::LegacyServiceRegistration));
    }

    #[test]
    fn invalid_signature_is_never_a_migration_candidate() {
        for legacy_jobs in [false, true] {
            for writable in [false, true] {
                assert_eq!(
                    assess(false, legacy_jobs, writable).blockers[0],
                    UpdateBlocker::UntrustedBundle
                );
            }
        }
    }

    #[test]
    fn signature_and_ownership_are_not_proof_of_operational_readiness() {
        assert_eq!(
            assess(true, false, true).blockers,
            vec![UpdateBlocker::UpdaterNotConfigured]
        );
    }

    #[test]
    fn all_states_remain_disabled_until_updater_is_implemented() {
        for trusted in [false, true] {
            for legacy_jobs in [false, true] {
                for writable in [false, true] {
                    assert!(assess(trusted, legacy_jobs, writable)
                        .blockers
                        .contains(&UpdateBlocker::UpdaterNotConfigured));
                }
            }
        }
    }
}
