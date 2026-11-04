//! Quality targets change encoding only, never geometry, input epochs or OS displays.
use super::*;
use rieul_daemon_core::generated::rpc::*;
use std::time::{Duration, Instant};

pub fn validate_video_probe(track: &DesktopTrack) -> bool {
    let v = &track.viewport;
    (2..=4096).contains(&v.width)
        && (2..=4096).contains(&v.height)
        && v.width % 2 == 0
        && v.height % 2 == 0
        && v.width * v.height <= 8_388_608
        && (1..=120).contains(&v.fps)
        && (1..=100_000_000).contains(&v.bitrate)
        && track.codec.codec.len() <= 128
        && baseline_42_bounds(track)
}
// Both current H.264 backends request Baseline level 4.2. A successful single
// frame cannot prove a target exceeds neither level frame-size nor MB/s limits.
// ITU H.264 Annex A, table A-1/A-2 (also FFmpeg libavcodec/h264_levels.c).
fn baseline_42_bounds(track: &DesktopTrack) -> bool {
    let Some(code) = track
        .codec
        .codec
        .strip_prefix("avc1.")
        .and_then(|v| u32::from_str_radix(v, 16).ok())
    else {
        return true;
    };
    if code >> 16 != 66 || code & 255 != 42 {
        return true;
    }
    let v = &track.viewport;
    let blocks = v.width.div_ceil(16) * v.height.div_ceil(16);
    blocks <= 8704 && blocks * v.fps <= 522240 && v.bitrate <= 50_000_000
}
pub(super) fn revision(config: &DesktopConfiguration) -> u64 {
    config
        .tracks
        .iter()
        .map(|t| t.codec_epoch)
        .max()
        .unwrap_or(0)
}
fn target(config: &DesktopConfiguration) -> DesktopQualityTarget {
    DesktopQualityTarget {
        fps: config.tracks.first().map(|t| t.viewport.fps).unwrap_or(60),
        total_bitrate: config.total_bitrate,
    }
}
fn ladder() -> Vec<DesktopQualityTarget> {
    [(15, 2_000_000), (30, 5_000_000), (60, 20_000_000)]
        .into_iter()
        .map(|(fps, total_bitrate)| DesktopQualityTarget { fps, total_bitrate })
        .collect()
}
pub(super) struct State {
    pub revision: u64,
    layout: u64,
    pub verified: Vec<DesktopQualityTarget>,
    pub adaptive: Vec<DesktopQualityTarget>,
    pub policy: DesktopQualityPolicy,
    pub last_change: Instant,
    pub healthy: u32,
    last_sample: Option<Instant>,
}
#[derive(Default)]
pub(super) struct Sample {
    received: Option<(Instant, u64, u64, u64, u64)>, // time, epoch, group, depth, processing us
    sent: Option<(Instant, u64, bool)>,
}
impl Sample {
    pub fn receive(&mut self, epoch: u64, group: u64, depth: u64, decode: u64, render: u64) {
        if self
            .received
            .is_some_and(|(_, old_epoch, old_group, _, _)| old_epoch == epoch && group <= old_group)
        {
            return;
        }
        self.received = Some((
            Instant::now(),
            epoch,
            group,
            depth,
            decode.saturating_add(render),
        ));
    }
}
impl Runtime {
    fn quality_snapshot(
        &self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        id: &str,
    ) -> Result<DesktopConfiguration, Error> {
        self.mutate(|d| {
            d.authorize(auth, connection, id, now)?;
            if !d.attachments[id].server_viewports {
                return Err(Error::Unsupported);
            }
            let config = self.configuration(id).ok_or(Error::Stale)?;
            if config.tracks.is_empty() {
                return Err(Error::Unsupported);
            }
            Ok(config)
        })
    }
    pub(crate) fn query_quality(
        &self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        request: DesktopQualityQuery,
    ) -> Result<DesktopQualitySupport, Error> {
        let _operation = self.quality_operation.try_lock().map_err(|_| Error::Busy)?;
        let config = self.quality_snapshot(auth, connection, now, &request.attach_id)?;
        let mut requested = request.candidates.unwrap_or_default();
        if requested.len() > 4 {
            return Err(Error::Limit);
        }
        requested.extend(ladder());
        requested.push(target(&config));
        requested.sort_by_key(|t| (t.fps, t.total_bitrate));
        requested.dedup();
        if requested.iter().any(|t| {
            !(1..=120).contains(&t.fps) || !(100_000..=100_000_000).contains(&t.total_bitrate)
        }) {
            return Err(Error::Invalid);
        }
        let backend = self.backend.as_ref().ok_or(Error::Unsupported)?;
        let started = Instant::now();
        let mut candidates = Vec::new();
        for target in requested {
            let mut tracks = config.tracks.clone();
            let bitrate = target.total_bitrate / tracks.len() as u64;
            let mut verification = DesktopQualityVerification::Verified;
            for track in &mut tracks {
                track.viewport.fps = target.fps;
                track.viewport.bitrate = bitrate;
                let result = if !validate_video_probe(track) {
                    DesktopQualityVerification::Unsupported
                } else if started.elapsed() > Duration::from_secs(2) {
                    DesktopQualityVerification::Unknown
                } else {
                    backend.probe_video(track)
                };
                if result == DesktopQualityVerification::Unsupported {
                    verification = result;
                } else if result == DesktopQualityVerification::Unknown
                    && verification != DesktopQualityVerification::Unsupported
                {
                    verification = result;
                }
            }
            let reason = match verification {
                DesktopQualityVerification::Verified => {
                    "Each exact encoder combination produced a synthetic keyframe. Simultaneous throughput and target FPS are not guaranteed."
                }
                DesktopQualityVerification::Unsupported => {
                    "This combination is outside the implemented codec or validation bounds."
                }
                _ => {
                    "Could not verify this combination now (backend, resources or bounded probe budget)."
                }
            };
            candidates.push(DesktopQualityCandidate {
                target,
                tracks,
                verification,
                reason: reason.into(),
            });
        }
        self.mutate(|d| {
            d.authorize(
                auth,
                connection,
                &request.attach_id,
                now.saturating_add(started.elapsed().as_millis() as u64),
            )?;
            if self.configuration(&request.attach_id).as_ref() != Some(&config) {
                return Err(Error::Stale);
            }
            let mut states = self.quality.lock().map_err(|_| Error::Backend)?;
            let previous = states
                .get(&request.attach_id)
                .filter(|s| s.revision == revision(&config));
            let adaptive = previous.map(|s| s.adaptive.clone()).unwrap_or_default();
            let last_change = previous.map(|s| s.last_change).unwrap_or_else(Instant::now);
            let healthy = previous.map(|s| s.healthy).unwrap_or(0);
            let last_sample = previous.and_then(|s| s.last_sample);
            let policy =
                previous
                    .map(|s| s.policy.clone())
                    .unwrap_or(DesktopQualityPolicy::Manual {
                        target: target(&config),
                    });
            let verified: Vec<_> = candidates
                .iter()
                .filter(|c| c.verification == DesktopQualityVerification::Verified)
                .map(|c| c.target.clone())
                .collect();
            let automatic_available = ladder().iter().filter(|t| verified.contains(t)).count() >= 2;
            states.insert(
                request.attach_id,
                State {
                    revision: revision(&config),
                    layout: config.layout_epoch,
                    verified,
                    adaptive,
                    policy: policy.clone(),
                    last_change,
                    healthy,
                    last_sample,
                },
            );
            Ok(DesktopQualitySupport {
                layout_epoch: config.layout_epoch,
                revision: revision(&config),
                candidates,
                automatic_available,
                concurrent_throughput_verified: false,
                policy,
            })
        })
    }
    pub(crate) fn set_quality(
        &self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        request: SetDesktopQualityReq,
    ) -> Result<DesktopConfiguration, Error> {
        let _operation = self.quality_operation.try_lock().map_err(|_| Error::Busy)?;
        let config = self.quality_snapshot(auth, connection, now, &request.attach_id)?;
        let desired = {
            let states = self.quality.lock().map_err(|_| Error::Backend)?;
            let state = states.get(&request.attach_id).ok_or(Error::Stale)?;
            if state.revision != request.revision
                || revision(&config) != request.revision
                || state.layout != request.layout_epoch
                || config.layout_epoch != request.layout_epoch
            {
                return Err(Error::Stale);
            }
            match &request.policy {
                DesktopQualityPolicy::Manual { target } if state.verified.contains(target) => {
                    target.clone()
                }
                DesktopQualityPolicy::Auto => {
                    let levels: Vec<_> = ladder()
                        .into_iter()
                        .filter(|t| state.verified.contains(t))
                        .collect();
                    if levels.len() < 2 {
                        return Err(Error::Unsupported);
                    }
                    levels.last().unwrap().clone()
                }
                _ => return Err(Error::Unsupported),
            }
        };
        self.apply_quality(
            auth,
            connection,
            now,
            &request.attach_id,
            &config,
            desired,
            request.policy,
            true,
        )
    }
    fn apply_quality(
        &self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        id: &str,
        config: &DesktopConfiguration,
        target: DesktopQualityTarget,
        policy: DesktopQualityPolicy,
        new_policy: bool,
    ) -> Result<DesktopConfiguration, Error> {
        let mut viewports: Vec<_> = config.tracks.iter().map(|t| t.viewport.clone()).collect();
        let bitrate = target.total_bitrate / viewports.len().max(1) as u64;
        for v in &mut viewports {
            v.fps = target.fps;
            v.bitrate = bitrate;
        }
        self.configure_impl(
            auth,
            connection,
            now,
            ConfigureDesktopViewportsReq {
                attach_id: id.into(),
                layout_epoch: config.layout_epoch,
                viewports,
                total_bitrate: target.total_bitrate,
            },
            true,
            Some((revision(config), policy, new_policy)),
        )
    }
    pub(crate) fn record_delivery(&self, id: &str, track: &DesktopTrack, slow: bool) {
        if let Ok(mut samples) = self.quality_samples.lock() {
            if samples.len() >= 128 && !samples.contains_key(&(id.into(), track.track_id)) {
                return;
            }
            samples.entry((id.into(), track.track_id)).or_default().sent =
                Some((Instant::now(), track.codec_epoch, slow));
        }
    }
    pub(crate) fn adjust_quality(
        &self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        id: &str,
    ) -> Result<(), Error> {
        let Ok(_operation) = self.quality_operation.try_lock() else {
            return Ok(());
        };
        let config = self.quality_snapshot(auth, connection, now, id)?;
        let desired = {
            let mut states = self.quality.lock().map_err(|_| Error::Backend)?;
            let Some(state) = states.get_mut(id) else {
                return Ok(());
            };
            if !matches!(state.policy, DesktopQualityPolicy::Auto)
                || state.revision != revision(&config)
                || state.layout != config.layout_epoch
                || state.last_change.elapsed() < Duration::from_secs(2)
            {
                return Ok(());
            }
            let samples = self.quality_samples.lock().map_err(|_| Error::Backend)?;
            let mut pressure = false;
            let mut healthy = true;
            let mut latest = None;
            for track in &config.tracks {
                let sample = samples.get(&(id.into(), track.track_id));
                let recv = sample.and_then(|s| s.received).filter(|(at, epoch, ..)| {
                    at.elapsed() < Duration::from_secs(2) && *epoch == track.codec_epoch
                });
                let sent = sample.and_then(|s| s.sent).filter(|(at, epoch, _)| {
                    at.elapsed() < Duration::from_secs(2) && *epoch == track.codec_epoch
                });
                if let Some((at, _, _, depth, micros)) = recv {
                    latest = Some(latest.map_or(at, |old: Instant| old.max(at)));
                    pressure |= depth >= 3 || micros > 2_000_000 / track.viewport.fps;
                    healthy &= depth == 0 && micros < 1_000_000 / track.viewport.fps;
                } else {
                    healthy = false;
                }
                if let Some((at, _, slow)) = sent {
                    latest = Some(latest.map_or(at, |old: Instant| old.max(at)));
                    pressure |= slow;
                    healthy &= !slow;
                } else {
                    healthy = false;
                }
            }
            if latest.is_none() || latest <= state.last_sample {
                return Ok(());
            }
            state.last_sample = latest;
            state.healthy = if healthy && !pressure {
                state.healthy + 1
            } else {
                0
            };
            let levels: Vec<_> = ladder()
                .into_iter()
                .filter(|t| state.adaptive.contains(t))
                .collect();
            let Some(index) = levels.iter().position(|t| *t == target(&config)) else {
                return Ok(());
            };
            if pressure && index > 0 {
                Some(levels[index - 1].clone())
            } else if state.healthy >= 5 && index + 1 < levels.len() {
                Some(levels[index + 1].clone())
            } else {
                None
            }
        };
        if let Some(target) = desired {
            self.apply_quality(
                auth,
                connection,
                now,
                id,
                &config,
                target,
                DesktopQualityPolicy::Auto,
                false,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    struct Auth(AtomicBool);
    impl Credentials for Auth {
        fn valid(&self, _: &str, _: u64) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
    struct Native {
        events: Mutex<Vec<DesktopInputEvent>>,
        verified: AtomicBool,
    }
    impl Backend for Native {
        fn capabilities(&self) -> DesktopCapabilities {
            DesktopCapabilities {
                capture: DesktopAvailability::Available,
                input: DesktopAvailability::Available,
                codecs: vec![DesktopCodec {
                    codec: "fixture".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }
        }
        fn displays(&self) -> Vec<DesktopDisplay> {
            vec![DesktopDisplay {
                display_id: "screen".into(),
                bounds: DesktopRect {
                    width: 1280,
                    height: 720,
                    ..Default::default()
                },
                scale: 1.0,
                dpi: 96.0,
                ..Default::default()
            }]
        }
        fn input(&self, e: &DesktopInputEvent) -> Result<(), Error> {
            self.events.lock().unwrap().push(e.clone());
            Ok(())
        }
        fn probe_video(&self, t: &DesktopTrack) -> DesktopQualityVerification {
            if t.viewport.fps == 120 {
                DesktopQualityVerification::Unsupported
            } else if self.verified.load(Ordering::SeqCst) {
                DesktopQualityVerification::Verified
            } else {
                DesktopQualityVerification::Unknown
            }
        }
    }
    fn setup() -> (Arc<Runtime>, Arc<Native>, Auth, String) {
        let native = Arc::new(Native {
            events: Mutex::new(vec![]),
            verified: AtomicBool::new(true),
        });
        let r = Runtime::new(Arc::new(WorkGate::default()), Some(native.clone()));
        let auth = Auth(AtomicBool::new(true));
        let event = r
            .attach(
                &auth,
                1,
                "paired",
                0,
                &AttachDesktopReq {
                    profile: PROFILE,
                    codecs: vec!["fixture".into()],
                    media_uni_streams: true,
                    keyboard_mode: DesktopKeyboardMode::Physical,
                },
            )
            .unwrap();
        let DesktopEvent::Attached { attach_id, .. } = event else {
            panic!()
        };
        r.configure_existing(&auth, 1, 0, &attach_id).unwrap();
        (r, native, auth, attach_id)
    }
    fn query(r: &Runtime, a: &Auth, id: &str) -> DesktopQualitySupport {
        r.query_quality(
            a,
            1,
            0,
            DesktopQualityQuery {
                attach_id: id.into(),
                candidates: None,
            },
        )
        .unwrap()
    }
    fn set(
        r: &Runtime,
        a: &Auth,
        id: &str,
        s: &DesktopQualitySupport,
        policy: DesktopQualityPolicy,
    ) -> Result<DesktopConfiguration, Error> {
        r.set_quality(
            a,
            1,
            0,
            SetDesktopQualityReq {
                attach_id: id.into(),
                layout_epoch: s.layout_epoch,
                revision: s.revision,
                policy,
            },
        )
    }
    #[test]
    fn voxl_pacing_never_reduces_manual_target() {
        let (r, _, a, id) = setup();
        let support = query(&r, &a, &id);
        let c = set(
            &r,
            &a,
            &id,
            &support,
            DesktopQualityPolicy::Manual {
                target: DesktopQualityTarget {
                    fps: 60,
                    total_bitrate: 20_000_000,
                },
            },
        )
        .unwrap();
        let t = &c.tracks[0];
        let n = Instant::now();
        let mut flow = crate::desktop_flow::Flow::new(t.codec_epoch);
        flow.sent(1, 0, 1000, n);
        flow.receipt(1, 0, n + std::time::Duration::from_millis(20));
        r.flow
            .lock()
            .unwrap()
            .insert((id.clone(), t.track_id), flow);
        assert_eq!(r.media_bitrate(&id, t), t.viewport.bitrate);
        r.quality.lock().unwrap().get_mut(&id).unwrap().policy = DesktopQualityPolicy::Auto;
        assert!(r.media_bitrate(&id, t) < t.viewport.bitrate);
    }
    fn cool(r: &Runtime, id: &str) {
        r.quality.lock().unwrap().get_mut(id).unwrap().last_change =
            Instant::now() - Duration::from_secs(3);
    }
    #[test]
    fn baseline_level_limits_apply_to_combinations_not_independent_maxima() {
        let mut track = DesktopTrack {
            codec: DesktopCodec {
                codec: "avc1.42002a".into(),
                ..Default::default()
            },
            viewport: DesktopViewport {
                width: 1920,
                height: 1080,
                fps: 60,
                bitrate: 20_000_000,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate_video_probe(&track));
        track.viewport.fps = 120;
        assert!(!validate_video_probe(&track));
        track.viewport.width = 1280;
        track.viewport.height = 720;
        assert!(validate_video_probe(&track));
        track.viewport.bitrate = 50_000_001;
        assert!(!validate_video_probe(&track));
        track.viewport.bitrate = 20_000_000;
        track.viewport.width = 3840;
        track.viewport.height = 2160;
        track.viewport.fps = 15;
        assert!(!validate_video_probe(&track));
    }
    #[test]
    fn query_classifies_combinations_and_manual_keeps_held_input_geometry() {
        let (r, n, a, id) = setup();
        let before = r.configuration(&id).unwrap();
        r.mutate(|d| d.set_control(&a, 1, &id, 0, DesktopControlAction::Acquire))
            .unwrap();
        let control = r.control().unwrap();
        r.accept_input(
            &a,
            1,
            0,
            DesktopInputFrame {
                attach_id: id.clone(),
                input_epoch: control.input_epoch,
                layout_epoch: before.layout_epoch,
                sequence: 1,
                event: DesktopInputEvent::PhysicalKey {
                    usage: 4,
                    down: true,
                    repeat: false,
                },
            },
        )
        .unwrap();
        let events = n.events.lock().unwrap().len();
        let s = r
            .query_quality(
                &a,
                1,
                0,
                DesktopQualityQuery {
                    attach_id: id.clone(),
                    candidates: Some(vec![DesktopQualityTarget {
                        fps: 120,
                        total_bitrate: 20_000_000,
                    }]),
                },
            )
            .unwrap();
        assert!(s.automatic_available);
        assert!(!s.concurrent_throughput_verified);
        assert_eq!(
            s.candidates.last().unwrap().verification,
            DesktopQualityVerification::Unsupported
        );
        assert_eq!(r.configuration(&id), Some(before.clone()));
        let after = set(
            &r,
            &a,
            &id,
            &s,
            DesktopQualityPolicy::Manual {
                target: ladder()[1].clone(),
            },
        )
        .unwrap();
        assert_eq!(after.layout_epoch, before.layout_epoch);
        assert!(revision(&after) > revision(&before));
        assert_eq!(
            after.tracks[0].viewport.crop,
            before.tracks[0].viewport.crop
        );
        assert_eq!(
            after.tracks[0].viewport.width,
            before.tracks[0].viewport.width
        );
        assert_eq!(r.control().unwrap(), control);
        assert!(r.state.lock().unwrap().keys.contains(&4));
        assert_eq!(n.events.lock().unwrap().len(), events);
        assert_eq!(
            set(&r, &a, &id, &s, DesktopQualityPolicy::Auto),
            Err(Error::Stale)
        );
        assert!(r.gate.begin_drain().is_none());
        r.close(1);
        assert!(
            n.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, DesktopInputEvent::ReleaseAll))
        );
        assert!(r.gate.begin_drain().is_some());
    }
    #[test]
    fn unknown_bounds_auth_and_revision_fail_closed() {
        let (r, n, a, id) = setup();
        n.verified.store(false, Ordering::SeqCst);
        let s = query(&r, &a, &id);
        assert!(!s.automatic_available);
        assert!(
            s.candidates
                .iter()
                .all(|c| c.verification == DesktopQualityVerification::Unknown)
        );
        assert_eq!(
            set(&r, &a, &id, &s, DesktopQualityPolicy::Auto),
            Err(Error::Unsupported)
        );
        assert_eq!(
            set(
                &r,
                &a,
                &id,
                &s,
                DesktopQualityPolicy::Manual {
                    target: ladder()[0].clone()
                }
            ),
            Err(Error::Unsupported)
        );
        assert_eq!(
            r.query_quality(
                &a,
                1,
                0,
                DesktopQualityQuery {
                    attach_id: id.clone(),
                    candidates: Some(vec![DesktopQualityTarget {
                        fps: 0,
                        total_bitrate: 1
                    }])
                }
            ),
            Err(Error::Invalid)
        );
        assert_eq!(
            r.query_quality(
                &a,
                1,
                0,
                DesktopQualityQuery {
                    attach_id: id.clone(),
                    candidates: Some(vec![ladder()[0].clone(); 5])
                }
            ),
            Err(Error::Limit)
        );
        a.0.store(false, Ordering::SeqCst);
        assert_eq!(
            r.query_quality(
                &a,
                1,
                0,
                DesktopQualityQuery {
                    attach_id: id,
                    candidates: None
                }
            ),
            Err(Error::NotFound)
        );
        let mut track = s.candidates[0].tracks[0].clone();
        track.viewport.width = u64::MAX;
        assert!(!validate_video_probe(&track));
    }
    #[test]
    fn automatic_uses_pressure_and_fresh_feedback_with_hysteresis_only() {
        let (r, _n, a, id) = setup();
        let s = query(&r, &a, &id);
        set(&r, &a, &id, &s, DesktopQualityPolicy::Auto).unwrap();
        cool(&r, &id);
        // Absence of feedback neither raises nor lowers a target.
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[2]);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        r.record_delivery(&id, &t, true);
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
        cool(&r, &id);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        for group in 1..=4 {
            r.quality_samples
                .lock()
                .unwrap()
                .entry((id.clone(), t.track_id))
                .or_default()
                .receive(t.codec_epoch, group, 0, 1, 1);
            r.record_delivery(&id, &t, false);
            r.adjust_quality(&a, 1, 0, &id).unwrap();
            assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
        }
        // Re-reading the same observation is not a fresh healthy sample.
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
        r.quality_samples
            .lock()
            .unwrap()
            .entry((id.clone(), t.track_id))
            .or_default()
            .receive(t.codec_epoch, 5, 0, 1, 1);
        r.record_delivery(&id, &t, false);
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[2]);
        let s = query(&r, &a, &id);
        set(
            &r,
            &a,
            &id,
            &s,
            DesktopQualityPolicy::Manual {
                target: ladder()[1].clone(),
            },
        )
        .unwrap();
        cool(&r, &id);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        r.record_delivery(&id, &t, true);
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
    }
    #[test]
    fn read_only_reprobe_does_not_disable_active_auto_policy() {
        let (r, n, a, id) = setup();
        let s = query(&r, &a, &id);
        set(&r, &a, &id, &s, DesktopQualityPolicy::Auto).unwrap();
        cool(&r, &id);
        n.verified.store(false, Ordering::SeqCst);
        let unknown = query(&r, &a, &id);
        assert!(!unknown.automatic_available);
        assert_eq!(unknown.policy, DesktopQualityPolicy::Auto);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        r.record_delivery(&id, &t, true);
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
        // A fresh unverified query still cannot authorize a new manual target.
        let unknown = query(&r, &a, &id);
        assert_eq!(
            set(
                &r,
                &a,
                &id,
                &unknown,
                DesktopQualityPolicy::Manual {
                    target: ladder()[0].clone()
                }
            ),
            Err(Error::Unsupported)
        );
    }
    #[test]
    fn duplicate_stale_and_missing_receiver_evidence_cannot_upgrade() {
        let (r, _n, a, id) = setup();
        let s = query(&r, &a, &id);
        set(&r, &a, &id, &s, DesktopQualityPolicy::Auto).unwrap();
        cool(&r, &id);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        r.record_delivery(&id, &t, true);
        r.adjust_quality(&a, 1, 0, &id).unwrap();
        cool(&r, &id);
        let t = r.configuration(&id).unwrap().tracks[0].clone();
        for _ in 0..10 {
            r.record_delivery(&id, &t, false);
            r.adjust_quality(&a, 1, 0, &id).unwrap();
        }
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
        let mut sample = Sample::default();
        sample.receive(t.codec_epoch, 8, 0, 1, 1);
        let first = sample.received;
        sample.receive(t.codec_epoch, 8, 100, 2, 2);
        sample.receive(t.codec_epoch, 7, 100, 2, 2);
        assert_eq!(sample.received, first);
        sample.received = Some((
            Instant::now() - Duration::from_secs(3),
            t.codec_epoch,
            9,
            0,
            1,
        ));
        r.quality_samples
            .lock()
            .unwrap()
            .insert((id.clone(), t.track_id), sample);
        for _ in 0..10 {
            r.record_delivery(&id, &t, false);
            r.adjust_quality(&a, 1, 0, &id).unwrap();
        }
        assert_eq!(target(&r.configuration(&id).unwrap()), ladder()[1]);
    }
}
