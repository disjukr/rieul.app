//! Update admission and two-phase exit leases. Ordinary installs wait for idle;
//! an explicitly confirmed force install may interrupt admitted work.
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
    pub active_calls: usize,
}
impl Workload {
    pub fn busy(&self) -> bool {
        self.blocks_update(false)
    }
    pub fn blocks_update(&self, manual: bool) -> bool {
        self.blocks_update_with_force(manual, false)
    }
    pub fn blocks_update_with_force(&self, manual: bool, force: bool) -> bool {
        if manual && force {
            return false;
        }
        (!manual && self.connections != 0)
            || self.terminals != 0
            || self.commands != 0
            || self.agents != 0
            || self.active_calls != 0
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrainRequest {
    pub nonce: String,
    pub commit: bool,
    pub manual: bool,
    pub force: bool,
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
    fn manual_confirmation_only_waives_connections_not_active_work() {
        assert!(!Workload {
            connections: 2,
            ..Default::default()
        }
        .blocks_update(true));
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
                active_calls: 1,
                ..Default::default()
            },
        ] {
            assert!(work.blocks_update(true));
            assert!(work.blocks_update(false));
        }
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

#[derive(Default)]
struct Admission {
    draining: bool,
    active: usize,
}
#[derive(Default)]
pub struct WorkGate(std::sync::Mutex<Admission>);
pub struct WorkGuard(Arc<WorkGate>);
pub struct DrainGuard(Arc<WorkGate>);
impl WorkGate {
    pub fn enter(self: &Arc<Self>) -> Option<WorkGuard> {
        let mut state = self.0.lock().ok()?;
        if state.draining {
            return None;
        }
        state.active += 1;
        Some(WorkGuard(self.clone()))
    }
    pub fn begin_drain(self: &Arc<Self>) -> Option<DrainGuard> {
        self.begin_update_drain(false)
    }
    pub(crate) fn begin_update_drain(self: &Arc<Self>, force: bool) -> Option<DrainGuard> {
        let mut state = self.0.lock().ok()?;
        if state.draining || (!force && state.active != 0) {
            return None;
        }
        state.draining = true;
        Some(DrainGuard(self.clone()))
    }
    pub fn active(&self) -> usize {
        self.0
            .lock()
            .map(|state| state.active)
            .unwrap_or(usize::MAX)
    }
}
#[cfg(test)]
#[test]
fn forced_update_closes_admission_even_with_active_work() {
    let gate = Arc::new(WorkGate::default());
    let existing = gate.enter().unwrap();
    assert!(gate.begin_drain().is_none());
    let drain = gate.begin_update_drain(true).unwrap();
    assert!(gate.enter().is_none());
    let busy = Workload { active_calls: 1, terminals: 1, ..Default::default() };
    assert!(busy.blocks_update_with_force(true, false));
    assert!(busy.blocks_update_with_force(false, true));
    assert!(!busy.blocks_update_with_force(true, true));
    drop(existing);
    assert!(gate.enter().is_none());
    drop(drain);
    assert!(gate.enter().is_some());
}
impl Drop for WorkGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.active -= 1;
        }
    }
}
impl Drop for DrainGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.draining = false;
        }
    }
}
#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn active_work_blocks_drain_and_drain_blocks_racing_work() {
        let gate = Arc::new(WorkGate::default());
        let work = gate.enter().unwrap();
        assert!(gate.begin_drain().is_none());
        drop(work);
        let drain = gate.begin_drain().unwrap();
        assert!(gate.enter().is_none());
        drop(drain);
        assert!(gate.enter().is_some());
    }
}

/// Only for a process that has never reached readiness or started its scheduler.
/// Failure to read/report a lease keeps it alive and cannot authorize a kill.
pub async fn wait_unstarted_drain(hooks: &MaintenanceHooks) {
    let mut lease: Option<(String, std::time::Instant)> = None;
    let mut expired = None;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        interval.tick().await;
        let request = match (hooks.request)() {
            Ok(Some(request)) => request,
            Ok(None) => {
                lease = None;
                expired = None;
                continue;
            }
            Err(_) => {
                lease = None;
                continue;
            }
        };
        if lease
            .as_ref()
            .is_some_and(|(nonce, _)| *nonce != request.nonce)
        {
            lease = None;
        }
        if let Some((nonce, deadline)) = &lease {
            if std::time::Instant::now() >= *deadline {
                let _ = (hooks.report)(nonce, DrainState::Expired);
                expired = Some(nonce.clone());
                lease = None;
            } else if request.commit {
                if (hooks.report)(nonce, DrainState::Exiting).is_ok() {
                    return;
                }
                lease = None;
            } else if (hooks.report)(
                nonce,
                DrainState::Granted {
                    remaining_ms: deadline
                        .saturating_duration_since(std::time::Instant::now())
                        .as_millis() as u64,
                },
            )
            .is_err()
            {
                lease = None;
            }
        } else if !request.commit && expired.as_ref() != Some(&request.nonce) {
            if (hooks.report)(
                &request.nonce,
                DrainState::Granted {
                    remaining_ms: 20_000,
                },
            )
            .is_ok()
            {
                lease = Some((
                    request.nonce,
                    std::time::Instant::now() + std::time::Duration::from_secs(20),
                ));
            }
        }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    #[tokio::test]
    async fn failed_start_requires_current_grant_before_commit() {
        let request = Arc::new(std::sync::Mutex::new(Some(DrainRequest {
            nonce: "first".into(),
            commit: true,
            manual: false,
            force: false,
        })));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let read = request.clone();
        let report = events.clone();
        let hooks = MaintenanceHooks {
            request: Arc::new(move || Ok(read.lock().unwrap().clone())),
            report: Arc::new(move |nonce, state| {
                report
                    .lock()
                    .unwrap()
                    .push((nonce.to_owned(), matches!(state, DrainState::Exiting)));
                Ok(())
            }),
        };
        let task = tokio::spawn(async move { wait_unstarted_drain(&hooks).await });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(events.lock().unwrap().is_empty());
        request.lock().unwrap().as_mut().unwrap().commit = false;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!events.lock().unwrap().is_empty());
        *request.lock().unwrap() = Some(DrainRequest {
            nonce: "replacement".into(),
            commit: true,
            manual: false,
            force: false,
        });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!task.is_finished());
        request.lock().unwrap().as_mut().unwrap().commit = false;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        request.lock().unwrap().as_mut().unwrap().commit = true;
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            events.lock().unwrap().last(),
            Some(&("replacement".into(), true))
        );
    }
}
