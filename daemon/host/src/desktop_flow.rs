//! ACK-window/age controller adapted from tembo/voxl src/video.rs::flow_ok,
//! a24c7171bc3b678101a14b3b21521836a414bf7b (MIT; third_party/voxl/LICENSE).
//! Adaptation: one attachment/track, actual rendered object receipts, a bounded
//! ledger, explicit refresh decision, and legacy feedback without an ACK gate.
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Send,
    Wait,
    Refresh,
}
struct Sent {
    id: (u64, u64),
    time: Instant,
}
pub(crate) struct Flow {
    pub epoch: u64,
    pending: VecDeque<Sent>,
    minimum_ms: Option<f64>,
    enabled: bool,
    refresh: bool,
}
impl Flow {
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            pending: VecDeque::new(),
            minimum_ms: None,
            enabled: false,
            refresh: false,
        }
    }
    pub fn sent(&mut self, group: u64, object: u64, now: Instant) {
        if self.pending.len() == 40 {
            self.pending.pop_front();
        }
        self.pending.push_back(Sent {
            id: (group, object),
            time: now,
        });
    }
    pub fn receipt(&mut self, group: u64, object: u64, now: Instant) {
        let id = (group, object);
        let Some(sent) = self.pending.iter().find(|s| s.id == id) else {
            return;
        };
        // Includes decoding/rendering; minimum observed delivery latency, not a
        // claim to know raw network RTT or link capacity.
        let ms = now.saturating_duration_since(sent.time).as_secs_f64() * 1000.;
        self.minimum_ms = Some(self.minimum_ms.map_or(ms, |old| old.min(ms)));
        self.enabled = true;
        self.pending.retain(|s| s.id > id);
    }
    pub fn request_refresh(&mut self) {
        self.refresh = true;
    }
    pub fn failed_group(&mut self, group: u64) {
        self.pending.retain(|s| s.id.0 != group);
        self.refresh = true;
    }
    pub fn next(&mut self, fps: u64, now: Instant) -> Decision {
        if self.refresh {
            self.refresh = false;
            self.pending.clear();
            return Decision::Refresh;
        }
        if !self.enabled || self.pending.is_empty() {
            return Decision::Send;
        }
        // The following bounds/thresholds are ported from voxl's flow_ok. A
        // stalled track is resynchronized independently, never blocking peers.
        let rtt = self.minimum_ms.unwrap_or(40.);
        let interval_ms = 1000. / fps.max(1) as f64;
        let max_n = (((rtt + 40.) / interval_ms).ceil() as usize + 2).clamp(3, 40);
        let max_age = rtt + 120.;
        let age = now.saturating_duration_since(self.pending.front().unwrap().time);
        if age > Duration::from_millis(4000) {
            self.pending.clear();
            return Decision::Refresh;
        }
        if self.pending.len() >= max_n || age.as_secs_f64() * 1000. > max_age {
            Decision::Wait
        } else {
            Decision::Send
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_receipts_only_and_legacy_is_bounded() {
        let n = Instant::now();
        let mut f = Flow::new(3);
        for i in 0..100 {
            f.sent(i, 0, n);
        }
        assert_eq!(f.pending.len(), 40);
        f.receipt(999, 0, n);
        assert!(!f.enabled);
        assert_eq!(f.next(60, n + Duration::from_secs(1)), Decision::Send);
        f.receipt(99, 0, n + Duration::from_millis(10));
        assert!(f.enabled);
        assert!(f.pending.is_empty());
    }
    #[test]
    fn paused_track_recovers_without_blocking_other_track() {
        let n = Instant::now();
        let mut a = Flow::new(1);
        let mut b = Flow::new(2);
        a.sent(1, 0, n);
        a.receipt(1, 0, n + Duration::from_millis(10));
        a.sent(2, 0, n);
        assert_eq!(a.next(60, n + Duration::from_millis(200)), Decision::Wait);
        assert_eq!(b.next(60, n + Duration::from_millis(200)), Decision::Send);
        assert_eq!(a.next(60, n + Duration::from_secs(5)), Decision::Refresh);
        assert_eq!(a.next(60, n + Duration::from_secs(5)), Decision::Send);
    }
    #[test]
    fn reset_and_failed_group_cannot_ack_future_objects() {
        let n = Instant::now();
        let mut f = Flow::new(1);
        f.sent(1, 0, n);
        f.failed_group(1);
        f.receipt(1, 0, n);
        assert!(!f.enabled);
        assert_eq!(f.next(60, n), Decision::Refresh);
        f.sent(2, 0, n);
        f.request_refresh();
        assert_eq!(f.next(60, n), Decision::Refresh);
        assert!(f.pending.is_empty());
    }
}
