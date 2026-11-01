//! Conservative local update drain: no disconnecting sessions or killing work.
//! A connected idle client also defers updates until it disconnects.
use anyhow::Result;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
#[derive(Clone, Debug, Default)]
pub struct Workload {
    pub connections: usize,
    pub terminals: usize,
    pub commands: usize,
    pub agents: usize,
}
impl Workload {
    pub fn busy(&self) -> bool {
        self.connections != 0 || self.terminals != 0 || self.commands != 0 || self.agents != 0
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrainRequest {
    pub nonce: String,
    pub commit: bool,
}
#[derive(Clone, Debug)]
pub enum DrainState {
    Busy(Workload),
    Granted { remaining_ms: u64 },
    Exiting,
    Expired,
}
pub struct MaintenanceHooks {
    pub request: Arc<dyn Fn() -> Result<Option<DrainRequest>> + Send + Sync>,
    pub report: Arc<dyn Fn(&str, DrainState) -> Result<()> + Send + Sync>,
}
pub(crate) struct ConnectionGuard(Arc<AtomicUsize>);
impl ConnectionGuard {
    pub fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_background_work_is_busy_without_connections() {
        for work in [
            Workload {
                terminals: 1,
                ..Default::default()
            },
            Workload {
                commands: 1,
                ..Default::default()
            },
            Workload {
                agents: 1,
                ..Default::default()
            },
            Workload {
                connections: 1,
                ..Default::default()
            },
        ] {
            assert!(work.busy());
        }
        assert!(!Workload::default().busy());
    }
    #[test]
    fn connection_count_survives_future_scope_and_releases_on_cancel() {
        let counter = Arc::new(AtomicUsize::new(0));
        let guard = ConnectionGuard::new(counter.clone());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        drop(guard);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}
