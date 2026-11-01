//! Restricted root updater implementation. No remote RPC or caller-supplied
//! URL/path/command is exposed. Production lifecycle activation is intentionally
//! not wired until the migration and signed launchd recovery tests pass.
#![allow(
    dead_code,
    reason = "Local updater engine awaiting production lifecycle integration; no installed entry point yet"
)]
mod archive;
mod preparation;
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
