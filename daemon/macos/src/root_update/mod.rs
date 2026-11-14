//! Restricted root updater implementation. No remote RPC or caller-supplied
//! URL/path/command is exposed. Production lifecycle activation is intentionally
//! not wired until the migration and signed launchd recovery tests pass.
#![allow(
    dead_code,
    reason = "Local updater engine awaiting production lifecycle integration; no installed entry point yet"
)]
mod archive;
#[cfg(target_os = "macos")]
mod control;
mod destination;
#[cfg(any(test, all(target_os = "macos", feature = "updater-device-repair")))]
mod device_repair;
#[cfg(all(target_os = "macos", feature = "updater-device-repair"))]
pub use device_repair::repair as repair_prepared_device;
mod drain;
mod gate;
#[cfg(target_os = "macos")]
mod migration;
#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
mod runtime;
#[cfg(target_os = "macos")]
pub use control::service as update_service;
#[cfg(target_os = "macos")]
pub use drain::hooks as maintenance_hooks;
#[cfg(target_os = "macos")]
pub use migration::prepare as prepare_migration;
#[cfg(target_os = "macos")]
pub use runtime::{startup as service_startup, worker as run_worker};
mod launchd;
pub use gate::{force_requested as gui_force_update_requested, shared as gui_update_guard};
mod preparation;
mod receipt;
#[cfg(target_os = "macos")]
pub use receipt::startup_callback;
mod source;
mod store;
mod transaction;
mod verify;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub const TEAM: &str = "D379GLRLPV";
pub const APP_ID: &str = "app.rieul";
pub const DAEMON_ID: &str = "rieul-macos-system";
pub const APP: &str = "/Applications/Rieul.app";
pub const SERVICE: &str = "/Library/Application Support/rieul/service/rieul-macos-system";
pub const STATE: &str = "/Library/Application Support/rieul/updates";
pub const DATABASE_SCHEMA: u32 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Version(pub u64, pub u64, pub u64);
impl Version {
    fn parse(s: &str) -> Result<Self> {
        let fields = s.split('.').collect::<Vec<_>>();
        ensure!(fields.len() == 3, "expected stable three-part version");
        let mut n = [0; 3];
        for (i, f) in fields.iter().enumerate() {
            ensure!(
                !f.is_empty()
                    && f.bytes().all(|b| b.is_ascii_digit())
                    && (f.len() == 1 || !f.starts_with('0')),
                "invalid version"
            );
            n[i] = f.parse()?;
        }
        Ok(Self(n[0], n[1], n[2]))
    }
    fn text(self) -> String {
        format!("{}.{}.{}", self.0, self.1, self.2)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Policy {
    pub schema: u32,
    pub enabled: bool,
}
impl Policy {
    fn allows(&self) -> bool {
        self.schema == 1 && self.enabled
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, target_os = "macos"))]
mod vm_integration;
#[cfg(all(test, target_os = "macos"))]
mod device_repair_fixture;
