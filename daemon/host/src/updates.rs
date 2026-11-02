//! Authenticated updater commands and bounded, ordered status snapshots.
use anyhow::Result;
use rieul_daemon_core::generated::rpc::{UpdatePhase, UpdateStatus, UpdateStatusOrdering};
use std::{future::Future, pin::Pin};
use tokio::sync::watch;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum UpdateCommand {
    Check,
    InstallConfirmed,
}
pub type UpdateRequest<'a> = Pin<Box<dyn Future<Output = Result<UpdateStatus>> + Send + 'a>>;
pub trait UpdateService: Send + Sync {
    fn status(&self) -> Result<UpdateStatus>;
    fn subscribe(&self) -> Result<watch::Receiver<UpdateStatus>>;
    fn request(&self, request: UpdateCommand) -> UpdateRequest<'_>;
    fn tick(&self, _work: &crate::maintenance::Workload) {}
}

/// One retained snapshot, regardless of subscriber speed. Publishing and revision
/// allocation happen under the same watch lock; subscribe cannot miss a change.
pub struct StatusFeed(watch::Sender<UpdateStatus>);
impl Default for StatusFeed {
    fn default() -> Self {
        let mut initial = unavailable();
        initial.ordering = UpdateStatusOrdering {
            epoch: format!("{:032x}", rand::random::<u128>()),
            revision: 0,
        };
        Self(watch::channel(initial).0)
    }
}
impl StatusFeed {
    pub fn publish(&self, mut status: UpdateStatus) -> UpdateStatus {
        self.0.send_if_modified(|previous| {
            status.ordering = previous.ordering.clone();
            if status == *previous {
                return false;
            }
            let order = &mut status.ordering;
            if order.revision == (1u64 << 53) - 1 {
                order.epoch = format!("{:032x}", rand::random::<u128>());
                order.revision = 0;
            } else {
                order.revision += 1;
            }
            *previous = status.clone();
            true
        });
        // Return the very snapshot assigned above, not a later concurrent publish.
        status
    }
    #[cfg(test)]
    pub(crate) fn receivers(&self) -> usize {
        self.0.receiver_count()
    }
    pub fn subscribe(&self) -> watch::Receiver<UpdateStatus> {
        self.0.subscribe()
    }
}
pub fn unavailable() -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Unavailable,
        current_version: None,
        target_version: None,
        reason: Some("Automatic updater is not activated on this daemon".into()),
        can_install: false,
        ordering: UpdateStatusOrdering {
            epoch: format!("{:032x}", rand::random::<u128>()),
            revision: 0,
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn snapshot_then_changes_are_ordered_and_slow_readers_are_bounded() {
        let feed = StatusFeed::default();
        let mut rx = feed.subscribe();
        let initial = rx.borrow_and_update().clone();
        let mut state = unavailable();
        state.phase = UpdatePhase::Checking;
        let first = feed.publish(state.clone());
        assert_eq!(first.ordering.revision, 1);
        assert_eq!(feed.publish(state.clone()), first);
        for n in 0..1000 {
            state.reason = Some(n.to_string());
            feed.publish(state.clone());
        }
        rx.changed().await.unwrap();
        let last = rx.borrow_and_update().clone();
        assert_eq!(last.reason.as_deref(), Some("999"));
        assert_eq!(last.ordering.epoch, initial.ordering.epoch);
        assert_eq!(*feed.subscribe().borrow(), last);
        assert!(!rx.has_changed().unwrap());
    }
}
