//! Native update-menu state. Transport authority stays outside this model.
use rieul_daemon_core::generated::rpc::{UpdatePhase, UpdateStatus};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Check,
    Install,
    ForceInstall,
    Restart,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub connection: u64,
    pub serial: u64,
    pub action: Action,
}
#[derive(Default)]
pub struct Updates {
    connection: u64,
    serial: u64,
    connected: bool,
    status: Option<UpdateStatus>,
    pending: Option<Request>,
    error: Option<String>,
}
impl Updates {
    pub fn reconnect(&mut self) -> u64 {
        self.connection += 1;
        self.connected = false;
        self.status = None;
        self.pending = None;
        self.error = None;
        self.connection
    }
    pub fn snapshot(&mut self, connection: u64, next: UpdateStatus) -> bool {
        if connection != self.connection || next.ordering.epoch.is_empty() {
            return false;
        }
        if let Some(current) = &self.status {
            if next.ordering.epoch != current.ordering.epoch
                || next.ordering.revision < current.ordering.revision
            {
                return false;
            }
        }
        self.connected = true;
        self.status = Some(next);
        true
    }
    pub fn disconnect(&mut self, connection: u64) {
        if connection == self.connection {
            self.connected = false;
            self.pending = None;
        }
    }
    pub fn can_check(&self) -> bool {
        self.connected
            && self.pending.is_none()
            && self.status.as_ref().is_some_and(|s| {
                matches!(
                    s.phase,
                    UpdatePhase::Idle
                        | UpdatePhase::Ready
                        | UpdatePhase::Deferred
                        | UpdatePhase::Failed
                )
            })
    }
    pub fn can_install(&self) -> bool {
        self.connected
            && self.pending.is_none()
            && self.status.as_ref().is_some_and(|s| {
                s.can_install
                    && matches!(
                        s.phase,
                        UpdatePhase::Ready | UpdatePhase::Deferred | UpdatePhase::Failed
                    )
            })
    }
    pub fn restart_label(&self) -> String {
        match self
            .status
            .as_ref()
            .filter(|s| s.can_install)
            .and_then(|s| s.target_version.as_deref())
        {
            Some(version) => format!("Restart and Update to {version}…"),
            None => "Restart Daemon…".into(),
        }
    }
    pub fn confirmation_title(&self, restart: bool) -> String {
        if restart {
            self.restart_label()
        } else {
            format!(
                "Install update {}?",
                self.status
                    .as_ref()
                    .and_then(|s| s.target_version.as_deref())
                    .unwrap_or("")
            )
        }
    }
    pub fn can_restart(&self) -> bool {
        self.connected
            && self.pending.is_none()
            && self.status.as_ref().is_some_and(|s| {
                matches!(
                    s.phase,
                    UpdatePhase::Unavailable
                        | UpdatePhase::Idle
                        | UpdatePhase::Ready
                        | UpdatePhase::Deferred
                        | UpdatePhase::Failed
                )
            })
    }
    pub fn confirmation(&self) -> Option<(u64, String, u64)> {
        if !self.connected {
            return None;
        }
        self.status.as_ref().map(|s| {
            (
                self.connection,
                s.ordering.epoch.clone(),
                s.ordering.revision,
            )
        })
    }
    pub fn connection(&self) -> u64 {
        self.connection
    }
    pub fn unavailable(&mut self, reason: String) {
        self.connected = false;
        self.pending = None;
        self.error = Some(reason);
    }
    pub fn request(&mut self, action: Action) -> Option<Request> {
        if !match action {
            Action::Check => self.can_check(),
            Action::Install | Action::ForceInstall => self.can_install(),
            Action::Restart => self.can_restart(),
        } {
            return None;
        }
        self.serial += 1;
        let request = Request {
            connection: self.connection,
            serial: self.serial,
            action,
        };
        self.pending = Some(request);
        self.error = None;
        Some(request)
    }
    pub fn complete(&mut self, request: Request, result: Result<UpdateStatus, String>) {
        if self.pending != Some(request) {
            return;
        }
        self.pending = None;
        match result {
            Ok(status) => {
                self.snapshot(request.connection, status);
            }
            Err(error) => self.error = Some(error),
        }
    }
    pub fn label(&self) -> &'static str {
        if !self.connected {
            return "Updates unavailable";
        }
        if self.pending.is_some_and(|r| r.action == Action::Check) {
            return "Checking for updates…";
        }
        if self.pending.is_some_and(|r| r.action == Action::Restart) {
            return "Requesting daemon restart…";
        }
        if self
            .pending
            .is_some_and(|r| r.action == Action::ForceInstall)
        {
            return "Requesting forced installation…";
        }
        if self.pending.is_some_and(|r| r.action == Action::Install) {
            return "Requesting installation…";
        }
        if self.error.is_some() {
            return "Update request failed";
        }
        match self.status.as_ref().map(|s| s.phase) {
            Some(UpdatePhase::Idle) => "Updates idle",
            Some(UpdatePhase::Checking) => "Checking for updates…",
            Some(UpdatePhase::Downloading) => "Downloading update…",
            Some(UpdatePhase::Verifying) => "Verifying update…",
            Some(UpdatePhase::Ready) => "Update ready to install",
            Some(UpdatePhase::Deferred) => "Update waiting for active work or clients",
            Some(UpdatePhase::Installing) => "Installing update…",
            Some(UpdatePhase::Restarting) => "Restarting daemon…",
            Some(UpdatePhase::Failed) => "Update failed",
            _ => "Updates unavailable",
        }
    }
    pub fn detail(&self) -> Option<&str> {
        self.error
            .as_deref()
            .or_else(|| self.status.as_ref().and_then(|s| s.reason.as_deref()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use rieul_daemon_core::generated::rpc::UpdateStatusOrdering;
    fn state(phase: UpdatePhase, revision: u64) -> UpdateStatus {
        UpdateStatus {
            phase,
            current_version: None,
            target_version: Some("1.2.3".into()),
            reason: Some("Fixture workload is active".into()),
            can_install: true,
            ordering: UpdateStatusOrdering {
                epoch: "fixture".into(),
                revision,
            },
        }
    }
    #[test]
    fn prepared_restart_names_the_update_and_version() {
        let mut m = Updates::default();
        let c = m.reconnect();
        let mut ready = state(UpdatePhase::Ready, 1);
        m.snapshot(c, ready.clone());
        assert_eq!(m.restart_label(), "Restart and Update to 1.2.3…");
        assert_eq!(m.confirmation_title(true), m.restart_label());
        ready.can_install = false;
        ready.ordering.revision = 2;
        m.snapshot(c, ready);
        assert_eq!(m.restart_label(), "Restart Daemon…");
    }
    #[test]
    fn restart_is_explicit_and_confirmation_expires_on_state_or_connection_change() {
        let mut m = Updates::default();
        assert!(m.request(Action::Restart).is_none());
        let c = m.reconnect();
        m.snapshot(c, state(UpdatePhase::Idle, 1));
        let token = m.confirmation();
        m.snapshot(c, state(UpdatePhase::Ready, 2));
        assert_ne!(token, m.confirmation());
        let request = m.request(Action::Restart).unwrap();
        assert!(m.request(Action::Check).is_none());
        m.disconnect(c);
        assert!(m.confirmation().is_none());
        let next = m.reconnect();
        m.snapshot(next, state(UpdatePhase::Idle, 0));
        m.complete(request, Ok(state(UpdatePhase::Restarting, 10)));
        assert!(m.can_restart());
        assert_eq!(m.label(), "Updates idle");
    }
    #[test]
    fn menu_is_inert_until_authenticated_transport_delivers_state_and_deduplicates_actions() {
        let mut m = Updates::default();
        assert!(m.request(Action::Check).is_none());
        let c = m.reconnect();
        assert!(m.snapshot(c, state(UpdatePhase::Ready, 1)));
        let request = m.request(Action::Check).unwrap();
        assert_eq!(m.label(), "Checking for updates…");
        assert!(m.request(Action::Install).is_none());
        m.snapshot(c, state(UpdatePhase::Downloading, 3));
        m.complete(request, Ok(state(UpdatePhase::Idle, 2)));
        assert_eq!(m.label(), "Downloading update…");
        assert!(!m.can_install());
    }
    #[test]
    fn deferral_failure_disconnect_and_replacement_keep_installation_explicit() {
        let mut m = Updates::default();
        let c = m.reconnect();
        m.snapshot(c, state(UpdatePhase::Deferred, 1));
        assert!(m.can_install());
        assert!(m.label().contains("active work"));
        assert_eq!(m.detail(), Some("Fixture workload is active"));
        let request = m.request(Action::Install).unwrap();
        m.complete(request, Err("Fixture IPC lost".into()));
        assert_eq!(m.label(), "Update request failed");
        m.disconnect(c);
        assert!(!m.can_install());
        let next = m.reconnect();
        m.snapshot(next, state(UpdatePhase::Ready, 0));
        m.complete(request, Ok(state(UpdatePhase::Installing, 9)));
        assert_eq!(m.label(), "Update ready to install");
        assert!(!m.snapshot(c, state(UpdatePhase::Installing, 10)));
    }
}
