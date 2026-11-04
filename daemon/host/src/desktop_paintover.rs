//! Adapted from MIT voxl video::encode_loop's last_motion/paintover_left logic.
//! Hardware encoders have no portable x264 macroblock/CRF refinement control.
//! Re-submit the retained image a bounded number of times after it settles,
//! preserving references within the current GOP and the negotiated rate target.
use std::time::Duration;

const DELAY: Duration = Duration::from_millis(200);
const BURST: u8 = 4;

#[derive(Default)]
pub struct Paintover {
    last_motion: Duration,
    remaining: u8,
}

impl Paintover {
    pub fn motion(&mut self, now: Duration) {
        self.last_motion = now;
        self.remaining = BURST;
    }

    pub fn pending(&self) -> bool {
        self.remaining != 0
    }

    pub fn due(&self, now: Duration) -> bool {
        self.pending() && now.saturating_sub(self.last_motion) >= DELAY
    }

    /// Call only after the retained-image frame was successfully delivered to
    /// the bounded output queue. New damage always takes precedence.
    pub fn painted(&mut self) {
        self.remaining = self.remaining.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_is_quiet_and_each_motion_rearms_one_bounded_burst() {
        let mut p = Paintover::default();
        assert!(!p.due(Duration::MAX));
        p.motion(Duration::from_millis(10));
        assert!(!p.due(Duration::from_millis(209)));
        for _ in 0..BURST {
            assert!(p.due(Duration::from_millis(210)));
            p.painted();
        }
        assert!(!p.pending());
        p.painted(); // duplicate completion cannot wrap the budget
        assert!(!p.pending());
        p.motion(Duration::from_millis(400));
        assert!(!p.due(Duration::from_millis(599)));
        assert!(p.due(Duration::from_millis(600)));
    }

    #[test]
    fn interrupted_delivery_does_not_consume_refinement_and_new_motion_wins() {
        let mut p = Paintover::default();
        p.motion(Duration::ZERO);
        assert!(p.due(DELAY));
        // No painted() on encoding/output failure. Retry retains the budget.
        assert!(p.due(DELAY));
        p.motion(DELAY);
        assert!(!p.due(DELAY));
        assert!(!p.due(Duration::ZERO));
        assert!(p.due(DELAY * 2));
    }
}
