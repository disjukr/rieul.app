//! Platform updater surface. Implementations enqueue work and return promptly;
//! authentication and live credential checks are enforced by RPC dispatch.
use anyhow::Result;
use rieul_daemon_core::generated::rpc::{RequestUpdateReq, UpdatePhase, UpdateStatus};
pub trait UpdateService: Send + Sync {
    fn status(&self) -> Result<UpdateStatus>;
    fn request(&self, request: RequestUpdateReq) -> Result<UpdateStatus>;
    fn tick(&self, _work: &crate::maintenance::Workload) {}
}
pub fn unavailable() -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Unavailable,
        current_version: None,
        target_version: None,
        reason: Some("Automatic updater is not activated on this daemon".into()),
        can_install: false,
    }
}
