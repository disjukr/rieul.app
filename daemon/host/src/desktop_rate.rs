//! Adapted from tembo/voxl src/video.rs::RateCtl, upstream a24c7171 (MIT).
//! Uses one authenticated track's rendered-byte delivery sample. Units are kbps.
//! This controls experimental transport pacing, not a visual-quality guarantee.
use std::time::{Duration, Instant};
pub(crate) struct RateCtl {
    target: f64,
    max: f64,
    min: f64,
    last_eval: Instant,
    last_dec: Instant,
    last_inc: Instant,
    /// Ramp multiplicatively until the first sign of congestion (like TCP slow start),
    /// so a session neither starts by flooding a slow link nor crawls up on a fast one.
    slow_start: bool,
    /// Delivery rate observed at the last congestion: the path's likely capacity.
    ceiling: f64,
    ceiling_at: Instant,
}

/// Starting point for a new session's bitrate cap (kbit/s).
const START_KBPS: f64 = 8000.0;

impl RateCtl {
    pub fn new(max: f64, min: f64, now: Instant) -> Self {
        let past = now - Duration::from_secs(10);
        RateCtl {
            target: START_KBPS.min(max).max(min),
            max,
            min,
            last_eval: past,
            last_dec: past,
            last_inc: past,
            slow_start: true,
            ceiling: f64::MAX,
            ceiling_at: past,
        }
    }

    pub fn update(
        &mut self,
        queue_ms: f64,
        age_ms: f64,
        minimum_ms: f64,
        delivered: f64,
        now: Instant,
    ) -> f64 {
        if now.saturating_duration_since(self.last_eval) < Duration::from_millis(100) {
            return self.target;
        }
        self.last_eval = now;
        let congested = queue_ms > 30. || age_ms > minimum_ms + 80.;
        let clear = queue_ms <= 15.;
        let rate = if congested && delivered > 0. {
            delivered
        } else {
            f64::MAX
        };
        if congested && now.saturating_duration_since(self.last_dec) >= Duration::from_millis(300) {
            let mut t = self.target * 0.85;
            // Delivery rate only says something about capacity when we were actually
            // pushing near the target; congestion from one big frame on an idle screen
            // would otherwise pin the ceiling at a few kbps.
            if rate.is_finite() && rate >= self.target * 0.5 {
                self.ceiling = rate;
                self.ceiling_at = now;
                t = t.min(rate * 0.85);
            }
            self.target = t.max(self.min);
            self.last_dec = now;
            self.slow_start = false;
        } else if self.slow_start
            && !congested
            && clear
            && now.saturating_duration_since(self.last_inc) >= Duration::from_millis(250)
        {
            // Only probe upward once the content actually presses against the cap.
            if delivered >= self.target * 0.5 {
                self.target = (self.target * 1.5).min(self.max);
                self.last_inc = now;
            }
        } else if !congested
            && clear
            && now.saturating_duration_since(self.last_dec) >= Duration::from_secs(1)
            && delivered >= self.target * 0.5
        {
            // Only raise the cap while the content actually uses it: an idle screen says
            // nothing about the path, and an inflated cap overshoots the next burst.
            // Paths change; forget a capacity estimate that hasn't been confirmed lately.
            if now.saturating_duration_since(self.ceiling_at) >= Duration::from_secs(15) {
                self.ceiling = f64::MAX;
            }
            // Recover quickly to just under the known capacity, then probe past it gently
            // so a busy link isn't driven into the queue every couple of seconds.
            if self.target < self.ceiling * 0.9
                && now.saturating_duration_since(self.last_inc) >= Duration::from_millis(200)
            {
                self.target = (self.target * 1.06 + 100.0)
                    .min(self.ceiling * 0.9)
                    .min(self.max);
                self.last_inc = now;
            } else if self.target >= self.ceiling * 0.9
                && now.saturating_duration_since(self.last_inc) >= Duration::from_millis(1000)
            {
                self.target = (self.target * 1.02).min(self.max);
                self.last_inc = now;
            }
        }
        self.target
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_does_not_raise_cap_and_congestion_respects_floor() {
        let n = Instant::now();
        let mut c = RateCtl::new(20000., 2000., n);
        assert_eq!(c.update(0., 0., 40., 0., n), 8000.);
        assert_eq!(
            c.update(50., 0., 40., 6000., n + Duration::from_secs(1)),
            5100.
        );
        for i in 2..20 {
            c.update(50., 0., 40., 1., n + Duration::from_secs(i));
        }
        assert_eq!(c.target, 2000.);
    }
    #[test]
    fn short_idle_sample_cannot_pin_capacity() {
        let n = Instant::now();
        let mut c = RateCtl::new(20000., 2000., n);
        c.update(50., 0., 40., 1., n);
        assert_eq!(c.ceiling, f64::MAX);
        let low = c.target;
        c.update(0., 0., 40., 8000., n + Duration::from_secs(2));
        assert!(c.target > low);
        assert!(c.target <= 20000.);
    }
    #[test]
    fn pressure_and_clear_recovery_are_bounded() {
        let n = Instant::now();
        let mut c = RateCtl::new(10000., 1000., n);
        assert_eq!(c.update(0., 0., 40., 8000., n), 10000.);
        let low = c.update(50., 0., 40., 6000., n + Duration::from_secs(1));
        assert_eq!(low, 5100.);
        let later = c.update(0., 0., 40., 6000., n + Duration::from_secs(3));
        assert!(later > low && later <= 10000.);
    }
}
