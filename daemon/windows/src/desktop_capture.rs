//! Per-track hardware pipeline. COM/DXGI/MF objects are created and dropped on
//! their capture worker. Input remains independent on the console input thread.
use crate::{desktop_native as native, desktop_pixels::nv12};
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
    let codec = if format == native::Codec::Av1 {
        crate::desktop_pixels::av1_independent(packet, &mut vec![]).map(|(c, _)| c)
    } else {
        crate::desktop::avc_codec(packet)
    };
    if codec.as_deref() != Some(t.codec.codec.as_str()) {
        return Err(Error::Unsupported);
    }
    Ok(())
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
        } else {
            native::Codec::H264
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
        let probe = make()?;
        let mut pixels = vec![128; (v.width * v.height * 3 / 2) as usize];
        pixels[..(v.width * v.height) as usize].fill(16);
        let short = format == native::Codec::H264
            && probe.encode_keyframe(&pixels, 0).is_ok()
            && probe
                .encode(&pixels, 1_000_000 / v.fps, false)
                .is_ok_and(|(_, key)| !key);
        drop(probe);
        drop(pixels);
        struct State {
            capture: native::Duplication,
            encoder: native::HardwareEncoder,
            latest_pixels: Option<Vec<u8>>,
            replay: bool,
            _apartment: native::Apartment,
        }
        let mut state = State {
            capture,
            encoder: make()?,
            latest_pixels: None,
            replay: false,
            _apartment: apartment,
        };
        let clock = Instant::now();
        Ok(
            move |refresh: bool,
                  bitrate: u64,
                  emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>| {
                let v = &t.viewport;
                state.encoder.set_bitrate(bitrate as u32);
                let count = if short {
                    rieul_daemon_host::desktop_worker::group_frames(v.fps)
                } else {
                    1
                };
                let group_start = Instant::now();
                for index in 0..count {
                    if index > 0 && group_start.elapsed() >= Duration::from_secs(1) {
                        break;
                    }
                    if !native::interactive() {
                        return Err(Error::Unauthorized);
                    }
                    let start = Instant::now();
                    let frame = state.capture.next().map_err(|_| Error::Backend)?;
                    if !native::interactive() {
                        return Err(Error::Unauthorized);
                    }
                    let Some(frame) = frame else {
                        if index == 0 && (refresh || state.replay) {
                            if let Some(pixels) = &state.latest_pixels {
                                let timestamp = clock.elapsed().as_micros() as u64;
                                let packet = state
                                    .encoder
                                    .encode_keyframe(pixels, timestamp)
                                    .map_err(|_| Error::Backend)?;
                                validate_key(&t, format, &packet)?;
                                emit(EncodedFrame::new(timestamp, true, packet))?;
                                state.replay = false;
                            }
                        }
                        break;
                    };
                    let pixels = nv12(
                        &frame.bytes,
                        (frame.width as usize, frame.height as usize, frame.stride),
                        (
                            v.crop.x.try_into().map_err(|_| Error::Invalid)?,
                            v.crop.y.try_into().map_err(|_| Error::Invalid)?,
                            v.crop.width as usize,
                            v.crop.height as usize,
                        ),
                        (v.width as usize, v.height as usize),
                    )
                    .ok_or(Error::Invalid)?;
                    let timestamp = clock.elapsed().as_micros() as u64;
                    let (packet, key) = state
                        .encoder
                        .encode(&pixels, timestamp, index == 0)
                        .map_err(|_| Error::Backend)?;
                    state.latest_pixels = Some(pixels);
                    if packet.len() > 4 * 1024 * 1024 {
                        return Err(Error::Limit);
                    }
                    if key {
                        validate_key(&t, format, &packet)?;
                        if index != 0 {
                            state.replay = true;
                            break;
                        }
                    }
                    state.replay = false;
                    emit(EncodedFrame::new(timestamp, key, packet))?;
                    if index + 1 < count {
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
