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

/// Extra refinement is allowed only from time saved at the current base rate.
/// This is not a strict limiter for motion or recovery IDRs (which must progress).
/// Units are bits * microseconds to retain fractional-byte credit without floats.
#[derive(Default)]
pub struct RefinementBudget {
    last: Option<Duration>,
    rate: u64,
    credit: i128,
    suppressed: bool,
}
impl RefinementBudget {
    fn update(&mut self, now: Duration, rate: u64) {
        if rate == 0 || self.last.is_some_and(|last| now < last) {
            self.credit = 0;
        } else if let Some(last) = self.last {
            let elapsed = now.saturating_sub(last).as_micros().min(250_000);
            self.credit = self
                .credit
                .saturating_add((elapsed * self.rate as u128) as i128);
        }
        // A lower controller target cannot inherit higher-rate burst credit.
        if rate < self.rate {
            self.credit = self.credit.min(0);
        }
        self.rate = rate;
        self.last = Some(now);
        self.credit = self.credit.min((rate as i128) * 250_000);
    }
    pub fn motion(&mut self) {
        self.suppressed = false;
    }
    /// Never exceed the negotiated target. Manual mode already runs at that
    /// target, so it receives no temporary increase. Automatic mode may have room.
    pub fn target(&mut self, now: Duration, base: u64, ceiling: u64, fps: u64) -> u64 {
        self.update(now, base);
        let target = base.saturating_mul(4).min(ceiling);
        if !self.suppressed
            && fps > 0
            && target > base
            && self.credit >= (target as i128) * 1_000_000 / fps as i128
        {
            target
        } else {
            base
        }
    }
    /// Account the whole object before exposing any stripe to the transport.
    /// Rejected refinement requires a fresh all-stripe key group at base rate.
    pub fn accept(&mut self, now: Duration, base: u64, bytes: usize, boosted: bool) -> bool {
        self.update(now, base);
        let cost = (bytes as i128).saturating_mul(8_000_000);
        if boosted && cost > self.credit {
            self.suppressed = true;
            return false;
        }
        self.credit = self
            .credit
            .saturating_sub(cost)
            .max(-4 * 1024 * 1024 * 8_000_000i128);
        true
    }
}
#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn idle_credit_never_changes_manual_target_and_oversize_suppresses_boost() {
        let mut b = RefinementBudget::default();
        assert_eq!(
            b.target(Duration::ZERO, 8_000_000, 32_000_000, 60),
            8_000_000
        );
        let idle = Duration::from_millis(250);
        assert_eq!(b.target(idle, 8_000_000, 8_000_000, 60), 8_000_000);
        assert_eq!(b.target(idle, 8_000_000, 32_000_000, 60), 32_000_000);
        assert!(!b.accept(idle, 8_000_000, 250_001, true));
        assert_eq!(b.target(idle, 8_000_000, 32_000_000, 60), 8_000_000);
        b.motion();
        assert_eq!(b.target(idle, 8_000_000, 32_000_000, 60), 32_000_000);
    }
    #[test]
    fn motion_and_recovery_costs_and_rate_reduction_remove_entitlement() {
        let mut b = RefinementBudget::default();
        b.target(Duration::ZERO, 8_000_000, 32_000_000, 60);
        assert!(b.accept(Duration::ZERO, 8_000_000, 500_000, false));
        assert_eq!(
            b.target(Duration::from_millis(250), 8_000_000, 32_000_000, 60),
            8_000_000
        );
        assert_eq!(
            b.target(Duration::from_millis(500), 8_000_000, 32_000_000, 60),
            8_000_000
        );
        assert_eq!(
            b.target(Duration::from_millis(750), 8_000_000, 32_000_000, 60),
            32_000_000
        );
        assert_eq!(
            b.target(Duration::from_millis(750), 4_000_000, 32_000_000, 60),
            4_000_000
        );
        assert_eq!(
            b.target(Duration::ZERO, 4_000_000, 32_000_000, 60),
            4_000_000
        );
    }
}

/// Setter+readback adapter must visit every stripe, even after partial failure.
/// None means the previous base rate cannot be proven restored; stop the pipeline.
pub fn transition_rate(
    refining: &mut bool,
    base: u64,
    target: u64,
    mut apply: impl FnMut(u64) -> bool,
) -> Option<bool> {
    let restored = apply(base);
    if *refining && !restored {
        return None;
    }
    *refining = false;
    if target <= base || !restored {
        return Some(false);
    }
    if apply(target) {
        *refining = true;
        return Some(true);
    }
    apply(base).then_some(false)
}
#[cfg(test)]
mod transition_tests {
    use super::*;
    #[test]
    fn partial_success_restores_all_stripes_or_stops() {
        for restored in [true, false] {
            let mut active = false;
            let mut calls = vec![];
            let mut results = [true, false, restored].into_iter();
            let result = transition_rate(&mut active, 8, 32, |rate| {
                calls.push(rate);
                results.next().unwrap()
            });
            assert_eq!(calls, vec![8, 32, 8]);
            assert_eq!(result, restored.then_some(false));
            assert!(!active);
        }
    }
    #[test]
    fn motion_and_new_target_restore_latest_base_before_encoding() {
        let mut active = true;
        let mut calls = vec![];
        assert_eq!(
            transition_rate(&mut active, 4, 4, |r| {
                calls.push(r);
                true
            }),
            Some(false)
        );
        assert_eq!(calls, vec![4]);
        assert!(!active);
        active = true;
        assert_eq!(transition_rate(&mut active, 4, 4, |_| false), None);
    }
}

/// Hardware adaptation of spatial paintover: independent 64x64 NV12 regions
/// settle independently. Encoders still consume whole stripes, not ROI/QP maps.
#[derive(Default)]
pub struct SpatialPaintover {
    width: usize,
    height: usize,
    previous: Vec<u8>,
    blocks: Vec<Paintover>,
    selected: Vec<usize>,
}
impl SpatialPaintover {
    pub fn observe(
        &mut self,
        y: &[u8],
        ys: usize,
        uv: &[u8],
        uvs: usize,
        width: usize,
        height: usize,
        now: Duration,
    ) -> Option<bool> {
        if width == 0
            || height == 0
            || width > 8192
            || height > 8192
            || width % 2 != 0
            || height % 2 != 0
            || ys < width
            || uvs < width
            || y.len() < ys.checked_mul(height)?
            || uv.len() < uvs.checked_mul(height / 2)?
        {
            return None;
        }
        let first = self.width != width || self.height != height;
        if first {
            self.width = width;
            self.height = height;
            self.previous = vec![0; width * height * 3 / 2];
            self.blocks = (0..width.div_ceil(64) * height.div_ceil(64))
                .map(|_| Paintover::default())
                .collect();
        }
        self.selected.clear();
        let mut motion = false;
        for by in 0..height.div_ceil(64) {
            for bx in 0..width.div_ceil(64) {
                let x = bx * 64;
                let right = (x + 64).min(width);
                let top = by * 64;
                let bottom = (top + 64).min(height);
                let mut changed = first;
                for (source, stride, offset, start, end) in [
                    (y, ys, 0, top, bottom),
                    (uv, uvs, width * height, top / 2, bottom / 2),
                ] {
                    for row in start..end {
                        let next = &source[row * stride + x..row * stride + right];
                        let old = &mut self.previous
                            [offset + row * width + x..offset + row * width + right];
                        changed |= old != next;
                        old.copy_from_slice(next);
                    }
                }
                if changed {
                    self.blocks[by * width.div_ceil(64) + bx].motion(now);
                    motion = true;
                }
            }
        }
        Some(motion)
    }
    /// Returns a stripe bit mask. A block crossing a stripe boundary refines both.
    /// Selection is consumed only after the complete object reaches the output.
    pub fn select(&mut self, now: Duration, stripes: &[(usize, usize)]) -> u32 {
        self.selected.clear();
        let mut mask = 0;
        for (i, block) in self.blocks.iter().enumerate() {
            if !block.due(now) {
                continue;
            }
            let top = i / self.width.div_ceil(64) * 64;
            let bottom = (top + 64).min(self.height);
            let mut selected = false;
            for (index, &(y, height)) in stripes.iter().take(32).enumerate() {
                if top < y.saturating_add(height) && y < bottom {
                    mask |= 1 << index;
                    selected = true;
                }
            }
            if selected {
                self.selected.push(i);
            }
        }
        mask
    }
    pub fn pending(&self) -> bool {
        self.blocks.iter().any(Paintover::pending)
    }
    pub fn painted(&mut self) {
        for i in self.selected.drain(..) {
            self.blocks[i].painted();
        }
    }
}

#[cfg(test)]
mod spatial_tests {
    use super::*;
    #[test]
    fn moving_neighbor_cannot_starve_settled_blocks_even_in_same_stripe() {
        let mut p = SpatialPaintover::default();
        let mut y = vec![16; 128 * 128];
        let uv = vec![128; 128 * 64];
        for frame in 0..30 {
            y[0] = frame;
            p.observe(
                &y,
                128,
                &uv,
                128,
                128,
                128,
                Duration::from_millis(frame as u64 * 20),
            )
            .unwrap();
            let mask = p.select(
                Duration::from_millis(frame as u64 * 20),
                &[(0, 64), (64, 64)],
            );
            if frame == 10 {
                assert_eq!(mask, 3);
            }
            if frame >= 14 {
                assert_eq!(mask, 0);
            }
            p.painted();
        }
        assert!(p.pending()); // moving block still waits for its own settle time
        assert_eq!(
            p.select(Duration::from_millis(800), &[(0, 64), (64, 64)]),
            1
        );
    }
    #[test]
    fn oversized_mixed_frame_recovers_at_base_despite_continuous_motion() {
        let mut spatial = SpatialPaintover::default();
        let mut budget = RefinementBudget::default();
        let mut y = vec![16; 128 * 64];
        let uv = vec![128; 128 * 32];
        spatial
            .observe(&y, 128, &uv, 128, 128, 64, Duration::ZERO)
            .unwrap();
        budget.accept(Duration::ZERO, 1_000_000, 0, false);
        let mut delivered = 0;
        for frame in 0..5 {
            let now = Duration::from_millis(250 + frame * 20);
            y[0] = frame as u8;
            let changed = spatial.observe(&y, 128, &uv, 128, 128, 64, now).unwrap();
            let selected = spatial.select(now, &[(0, 64)]) != 0;
            if changed && !selected {
                budget.motion();
            }
            let target = budget.target(now, 1_000_000, 4_000_000, 60);
            if frame == 0 {
                assert!(target > 1_000_000);
            } else {
                assert_eq!(target, 1_000_000);
            }
            if budget.accept(now, 1_000_000, 100_000, target > 1_000_000) {
                spatial.painted();
                delivered += 1;
            }
        }
        assert_eq!(delivered, 4);
    }
    #[test]
    fn chroma_motion_padding_failure_and_delivery_are_independent() {
        let mut p = SpatialPaintover::default();
        let y = vec![16; 130 * 128];
        let mut uv = vec![128; 130 * 64];
        p.observe(&y, 130, &uv, 130, 128, 128, Duration::ZERO)
            .unwrap();
        uv[0] = 90;
        p.observe(&y, 130, &uv, 130, 128, 128, Duration::from_millis(100))
            .unwrap();
        assert_eq!(p.select(DELAY, &[(0, 64), (64, 64)]), 3);
        // Failed delivery does not consume a selection.
        assert_eq!(p.select(DELAY, &[(0, 64), (64, 64)]), 3);
        assert!(p.observe(&[], 130, &uv, 130, 128, 128, DELAY).is_none());
        for _ in 0..4 {
            p.select(DELAY, &[(0, 64), (64, 64)]);
            p.painted();
        }
        assert_eq!(p.select(DELAY, &[(0, 64), (64, 64)]), 0);
        assert_eq!(
            p.select(Duration::from_millis(300), &[(0, 64), (64, 64)]),
            1
        );
    }
}
