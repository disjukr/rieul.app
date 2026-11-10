//! Per-track hardware pipeline. COM/DXGI/MF objects are created and dropped on
//! their capture worker. Input remains independent on the console input thread.
use crate::{desktop_native as native, desktop_pixels::nv12_update};
use rieul_daemon_core::generated::rpc::*;
use rieul_daemon_host::{
    desktop::{EncodedFrame, Error},
    desktop_worker::Worker,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
struct Track {
    config: DesktopTrack,
    worker: Mutex<Option<Worker>>,
}
#[derive(Default)]
pub struct Captures {
    tracks: Mutex<BTreeMap<(u64, u64), Arc<Track>>>,
}
impl Captures {
    pub fn end(&self, t: &DesktopTrack) -> Result<(), Error> {
        let track = self
            .tracks
            .lock()
            .map_err(|_| Error::Backend)?
            .remove(&(t.track_id, t.codec_epoch));
        if let Some(track) = track {
            let worker = track.worker.lock().map_err(|_| Error::Backend)?.take();
            drop(worker);
        }
        Ok(())
    }
    pub fn stream(
        &self,
        t: &DesktopTrack,
        refresh: bool,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.stream_at_rate(t, refresh, t.viewport.bitrate, emit)
    }
    pub fn stream_at_rate(
        &self,
        t: &DesktopTrack,
        refresh: bool,
        bitrate: u64,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        rieul_daemon_host::desktop::validate_encoder_rate(t, bitrate)?;
        let key = (t.track_id, t.codec_epoch);
        let track = {
            let mut tracks = self.tracks.lock().map_err(|_| Error::Backend)?;
            if !tracks.contains_key(&key) {
                if tracks.len() >= 32 {
                    return Err(Error::Limit);
                }
                tracks.insert(
                    key,
                    Arc::new(Track {
                        config: t.clone(),
                        worker: Mutex::new(Some(create(t.clone())?)),
                    }),
                );
            }
            tracks[&key].clone()
        };
        if track.config != *t {
            return Err(Error::Stale);
        }
        let worker = track.worker.lock().map_err(|_| Error::Backend)?;
        worker
            .as_ref()
            .ok_or(Error::Stale)?
            .group_at_rate(refresh, bitrate, emit)
    }
}
fn validate_key(t: &DesktopTrack, format: native::Codec, packet: &[u8]) -> Result<(), Error> {
    if packet.len() > 4 * 1024 * 1024 {
        return Err(Error::Limit);
    }
    let codec = crate::desktop::packet_codec(format, packet);
    if codec.as_deref() != Some(t.codec.codec.as_str()) {
        return Err(Error::Unsupported);
    }
    Ok(())
}
// All encoder objects remain on the same COM capture worker. Unlike macOS,
// this first implementation encodes stripes sequentially, not on foreign threads.
pub(crate) struct Stripes {
    layout: Vec<DesktopStripe>,
    encoders: Vec<native::HardwareEncoder>,
    previous: Vec<Vec<u8>>,
    width: usize,
    height: usize,
    codec: String,
    format: native::Codec,
}
impl Stripes {
    pub(crate) fn new(t: &DesktopTrack) -> Result<Self, Error> {
        use rieul_daemon_core::desktop_stripe as stripe;
        let layout = t.stripes.clone().ok_or(Error::Invalid)?;
        let v = &t.viewport;
        let format = if t.codec.codec.starts_with("avc1.") {
            native::Codec::H264
        } else if t.codec.codec.starts_with("hev1.") {
            native::Codec::Hevc
        } else {
            return Err(Error::Unsupported);
        };
        if !stripe::valid_layout(v.height, &layout) {
            return Err(Error::Unsupported);
        }
        let rates = stripe::rates(
            v.bitrate.try_into().map_err(|_| Error::Invalid)?,
            v.height,
            &layout,
        )
        .ok_or(Error::Invalid)?;
        let encoders = layout
            .iter()
            .zip(rates)
            .map(|(s, rate)| {
                native::HardwareEncoder::with_codec(
                    v.width as u32,
                    s.height as u32,
                    v.fps as u32,
                    rate,
                    format,
                )
                .map_err(|_| Error::Unsupported)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            previous: vec![vec![]; layout.len()],
            layout,
            encoders,
            width: v.width as usize,
            height: v.height as usize,
            codec: t.codec.codec.clone(),
            format,
        })
    }
    fn rate(&self, total: u32) -> Result<(), Error> {
        let rates =
            rieul_daemon_core::desktop_stripe::rates(total, self.height as u64, &self.layout)
                .ok_or(Error::Invalid)?;
        for (encoder, rate) in self.encoders.iter().zip(rates) {
            encoder.set_bitrate(rate);
        }
        Ok(())
    }
    fn verified_rate(&self, total: u32) -> Result<bool, Error> {
        self.rate(total)?;
        let rates =
            rieul_daemon_core::desktop_stripe::rates(total, self.height as u64, &self.layout)
                .ok_or(Error::Invalid)?;
        Ok(self
            .encoders
            .iter()
            .zip(rates)
            .all(|(e, r)| e.bitrate_matches(r)))
    }
    // None means identical pixels. A spontaneous IDR discards the whole bundle;
    // the caller starts a fresh group before anything is sent to the receiver.
    pub(crate) fn encode(
        &mut self,
        pixels: &[u8],
        timestamp: u64,
        key: bool,
        force: bool,
    ) -> Result<Option<(Vec<u8>, bool)>, Error> {
        self.encode_mask(pixels,timestamp,key,if force {u32::MAX} else {0})
    }
    fn encode_mask(&mut self,pixels:&[u8],timestamp:u64,key:bool,force:u32)->Result<Option<(Vec<u8>,bool)>,Error> {
        use rieul_daemon_core::desktop_stripe as stripe;
        let mut packets = vec![];
        for index in 0..self.layout.len() {
            let region = stripe::nv12_region(pixels, self.width, self.height, &self.layout[index])
                .ok_or(Error::Invalid)?;
            if !key && force & (1<<index) == 0 && self.previous[index] == region {
                continue;
            }
            let (data, actual_key) = self.encoders[index]
                .encode(&region, timestamp, key)
                .map_err(|_| Error::Backend)?;
            if actual_key
                && crate::desktop::packet_codec(self.format, &data).as_deref() != Some(self.codec.as_str())
            {
                return Err(Error::Unsupported);
            }
            if key && !actual_key {
                return Err(Error::Unsupported);
            }
            if actual_key != key {
                return Ok(Some((vec![], actual_key)));
            }
            self.previous[index] = region;
            packets.push((index as u8, actual_key, data));
        }
        if packets.is_empty() {
            return Ok(None);
        }
        let views: Vec<_> = packets
            .iter()
            .map(|(index, keyframe, data)| stripe::Packet {
                index: *index,
                keyframe: *keyframe,
                data,
            })
            .collect();
        Ok(Some((
            stripe::encode(&views, self.layout.len(), key).ok_or(Error::Limit)?,
            key,
        )))
    }
}

pub(crate) fn probe_stripes(t: &DesktopTrack) -> bool {
    if !rieul_daemon_host::desktop::validate_video_probe(t) {
        return false;
    }
    let Ok(mut probe) = Stripes::new(t) else {
        return false;
    };
    let mut pixels = vec![128; (t.viewport.width * t.viewport.height * 3 / 2) as usize];
    pixels[..(t.viewport.width * t.viewport.height) as usize].fill(16);
    probe
        .encode(&pixels, 0, true, true)
        .is_ok_and(|r| r.is_some_and(|(b, k)| k && !b.is_empty()))
        && probe
            .encode(&pixels, 1_000_000 / t.viewport.fps, false, true)
            .is_ok_and(|r| r.is_some_and(|(b, k)| !k && !b.is_empty()))
}

fn create(t: DesktopTrack) -> Result<Worker, Error> {
    if !rieul_daemon_host::desktop::validate_video_probe(&t) {
        return Err(Error::Invalid);
    }
    Worker::new(move || {
        let apartment = native::Apartment::enter().map_err(|_| Error::Backend)?;
        if !native::interactive() {
            return Err(Error::Unauthorized);
        }
        let v = &t.viewport;
        let (a, o) = v.display_id.split_once('.').ok_or(Error::Invalid)?;
        let capture = native::Duplication::open(
            a.parse().map_err(|_| Error::Invalid)?,
            o.parse().map_err(|_| Error::Invalid)?,
        )
        .map_err(|_| Error::Backend)?;
        let format = if t.codec.codec.starts_with("av01.") {
            native::Codec::Av1
        } else if t.codec.codec.starts_with("hev1.") {
            native::Codec::Hevc
        } else if t.codec.codec.starts_with("avc1.") {
            native::Codec::H264
        } else {
            return Err(Error::Unsupported);
        };
        let make = || {
            native::HardwareEncoder::with_codec(
                v.width as u32,
                v.height as u32,
                v.fps as u32,
                v.bitrate as u32,
                format,
            )
            .map_err(|_| Error::Backend)
        };
        // Probe delta support using synthetic pixels. Recreate after probing so
        // probe timestamps/references never enter the live media sequence.
        let striped = t.stripes.is_some();
        let probe = if striped { None } else { Some(make()?) };
        let mut pixels = vec![128; (v.width * v.height * 3 / 2) as usize];
        pixels[..(v.width * v.height) as usize].fill(16);
        let short = if striped {
            let mut probe = Stripes::new(&t)?;
            probe.encode(&pixels, 0, true, true)?;
            probe
                .encode(&pixels, 1_000_000 / v.fps, false, true)?
                .is_some_and(|(_, key)| !key)
        } else {
            format != native::Codec::Av1
                && probe.as_ref().unwrap().encode_keyframe(&pixels, 0).is_ok()
                && probe
                    .as_ref()
                    .unwrap()
                    .encode(&pixels, 1_000_000 / v.fps, false)
                    .is_ok_and(|(_, key)| !key)
        };
        drop(probe);
        drop(pixels);
        struct State {
            capture: Option<native::Duplication>,
            encoder: Option<native::HardwareEncoder>,
            stripes: Option<Stripes>,
            latest_pixels: Option<Vec<u8>>,
            replay: bool,
            capture_retries: u8,
            refining: bool,
            budget: rieul_daemon_host::desktop_paintover::RefinementBudget,
            paintover: rieul_daemon_host::desktop_paintover::SpatialPaintover,
            _apartment: native::Apartment,
        }
        let mut state = State {
            capture: Some(capture),
            encoder: if striped { None } else { Some(make()?) },
            stripes: if striped {
                Some(Stripes::new(&t)?)
            } else {
                None
            },
            latest_pixels: None,
            replay: false,
            capture_retries: 0,
            refining: false,
            budget: Default::default(),
            paintover: Default::default(),
            _apartment: apartment,
        };
        let clock = Instant::now();
        Ok(
            move |refresh: bool,
                  bitrate: u64,
                  emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>| {
                let v = &t.viewport;
                if let Some(stripes) = &state.stripes {
                    stripes.rate(bitrate as u32)?;
                }
                if let Some(encoder) = &state.encoder {
                    encoder.set_bitrate(bitrate as u32);
                }
                let count = if short {
                    rieul_daemon_host::desktop_worker::group_frames(v.fps)
                } else {
                    1
                };
                let group_start = Instant::now();
                let mut index = 0;
                while index < count && group_start.elapsed() < Duration::from_secs(1) {
                    if !native::interactive() {
                        return Err(Error::Unauthorized);
                    }
                    let start = Instant::now();
                    let frame = match state.capture.as_ref().ok_or(Error::Backend)?.next() {
                        Ok(frame) => frame,
                        Err(error)
                            if native::capture_access_lost(&error) && state.capture_retries < 3 =>
                        {
                            state.capture_retries += 1;
                            if !native::interactive() {
                                return Err(Error::Unauthorized);
                            }
                            let (adapter, output) =
                                v.display_id.split_once('.').ok_or(Error::Invalid)?;
                            let bounds = state.capture.as_ref().ok_or(Error::Backend)?.bounds;
                            crate::desktop_recovery::reopen(&mut state.capture, || {
                                let replacement = native::Duplication::open(
                                    adapter.parse().map_err(|_| Error::Invalid)?,
                                    output.parse().map_err(|_| Error::Invalid)?,
                                )
                                .map_err(|_| Error::Backend)?;
                                if replacement.bounds != bounds {
                                    return Err(Error::Stale);
                                }
                                Ok(replacement)
                            })?;
                            state.latest_pixels = None;
                            state.paintover = Default::default();
                            state.budget = Default::default();
                            state.replay = true;
                            break;
                        }
                        Err(_) => return Err(Error::Backend),
                    };
                    if !native::interactive() {
                        return Err(Error::Unauthorized);
                    }
                    let captured = frame.is_some();
                    if let Some(frame) = frame {
                        state.capture_retries = 0;
                        let pixels = state.latest_pixels.get_or_insert_with(Vec::new);
                        nv12_update(
                            &frame.bytes,
                            (frame.width as usize, frame.height as usize, frame.stride),
                            (
                                v.crop.x.try_into().map_err(|_| Error::Invalid)?,
                                v.crop.y.try_into().map_err(|_| Error::Invalid)?,
                                v.crop.width as usize,
                                v.crop.height as usize,
                            ),
                            (v.width as usize, v.height as usize),
                            &frame.damage,
                            pixels,
                        )
                        .ok_or(Error::Invalid)?;
                    }
                    let Some(pixels) = state.latest_pixels.as_ref() else { break; };
                    let w=v.width as usize; let h=v.height as usize;
                    let damaged=state.paintover.observe(&pixels[..w*h],w,&pixels[w*h..],w,w,h,clock.elapsed()).ok_or(Error::Invalid)?;
                                        let layout:Vec<_>=t.stripes.as_ref().map(|s|s.iter().map(|s|(s.y as usize,s.height as usize)).collect()).unwrap_or_else(||vec![(0,h)]);
                    let mask=if short {state.paintover.select(clock.elapsed(),&layout)} else {0};
                    let paintover=mask!=0;
                    if damaged && !paintover {state.budget.motion();}
                    if !captured && !paintover && !(index == 0 && (refresh || state.replay)) {
                        if short && state.paintover.pending() {
                            continue;
                        }
                        break;
                    }
                    let Some(pixels) = state.latest_pixels.as_ref() else {
                        break;
                    };
                    let target = if paintover {
                        state
                            .budget
                            .target(clock.elapsed(), bitrate, v.bitrate, v.fps)
                    } else {
                        bitrate
                    };
                    let apply = |rate: u32| -> Result<bool, Error> {
                        if let Some(stripes) = &state.stripes {
                            stripes.verified_rate(rate)
                        } else {
                            let encoder = state.encoder.as_ref().unwrap();
                            encoder.set_bitrate(rate);
                            Ok(encoder.bitrate_matches(rate))
                        }
                    };
                    let boosted = if state.refining || target > bitrate {
                        rieul_daemon_host::desktop_paintover::transition_rate(
                            &mut state.refining,
                            bitrate,
                            target,
                            |rate| apply(rate as u32).unwrap_or(false),
                        )
                        .ok_or(Error::Backend)?
                    } else {
                        false
                    };
                    let timestamp = clock.elapsed().as_micros() as u64;
                    let (packet, key) = if let Some(stripes) = &mut state.stripes {
                        match stripes.encode_mask(
                            pixels,
                            timestamp,
                            index == 0,
                            mask,
                        )? {
                            Some(result) => result,
                            None => continue,
                        }
                    } else {
                        state
                            .encoder
                            .as_ref()
                            .unwrap()
                            .encode(pixels, timestamp, index == 0)
                            .map_err(|_| Error::Backend)?
                    };
                    if packet.len() > 4 * 1024 * 1024 {
                        return Err(Error::Limit);
                    }
                    if key {
                        if !striped {
                            validate_key(&t, format, &packet)?;
                        }
                        if index != 0 {
                            state.replay = true;
                            break;
                        }
                    }
                    state.replay = false;
                    if !state
                        .budget
                        .accept(clock.elapsed(), bitrate, packet.len(), boosted)
                    {
                        state.replay = true;
                        break;
                    }
                    emit(EncodedFrame::new(timestamp, key, packet))?;
                    if paintover {
                        state.paintover.painted();
                    }
                    index += 1;
                    if index < count {
                        std::thread::sleep(
                            Duration::from_secs_f64(1. / v.fps as f64)
                                .saturating_sub(start.elapsed()),
                        );
                    }
                }
                Ok(())
            },
        )
    })
}

#[cfg(test)]
mod stripe_tests {
    use super::*;
    #[test]
    #[ignore = "allocated-pixel hardware test; requires a real Windows hardware H264 encoder"]
    fn synthetic_stripe_key_delta_selective_and_recovery() {
        synthetic_stripe_codec(native::Codec::H264);
    }
    #[test]
    #[ignore = "allocated-pixel hardware test; requires a real Windows hardware HEVC encoder"]
    fn synthetic_hevc_stripe_key_delta_selective_and_recovery() {
        synthetic_stripe_codec(native::Codec::Hevc);
    }
    fn synthetic_stripe_codec(format: native::Codec) {
        let _apartment = native::Apartment::enter().unwrap();
        let full =
            native::HardwareEncoder::with_codec(640, 480, 60, 2_000_000, format)
                .unwrap();
        let mut pixels = vec![128; 640 * 480 * 3 / 2];
        pixels[..640 * 480].fill(16);
        let codec = crate::desktop::packet_codec(format, &full.encode_keyframe(&pixels, 0).unwrap()).unwrap();
        drop(full);
        let track = DesktopTrack {
            codec: DesktopCodec {
                codec,
                hardware: true,
                description: None,
            },
            viewport: DesktopViewport {
                width: 640,
                height: 480,
                fps: 60,
                bitrate: 2_000_000,
                ..Default::default()
            },
            stripes: rieul_daemon_core::desktop_stripe::layout(480, 2),
            ..Default::default()
        };
        assert!(probe_stripes(&track));
        let mut encoder = Stripes::new(&track).unwrap();
        let (first, key) = encoder.encode(&pixels, 0, true, true).unwrap().unwrap();
        assert!(key);
        assert_eq!(
            rieul_daemon_core::desktop_stripe::decode(&first, 2, true)
                .unwrap()
                .len(),
            2
        );
        assert!(encoder
            .encode(&pixels, 16_666, false, false)
            .unwrap()
            .is_none());
        pixels[..640 * 240].fill(32);
        let (delta, key) = encoder
            .encode(&pixels, 33_333, false, false)
            .unwrap()
            .unwrap();
        assert!(!key);
        let packets = rieul_daemon_core::desktop_stripe::decode(&delta, 2, false).unwrap();
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].index, 0);
        let (recovery, key) = encoder
            .encode(&pixels, 50_000, true, true)
            .unwrap()
            .unwrap();
        assert!(key);
        assert_eq!(
            rieul_daemon_core::desktop_stripe::decode(&recovery, 2, true)
                .unwrap()
                .len(),
            2
        );
    }
}
