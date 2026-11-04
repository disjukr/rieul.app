//! One thread owns COM, DXGI/MF and held input for the active console user.
//! The system service must use authenticated IPC, never instantiate this backend.
use crate::{desktop_native as native, desktop_pixels::scan_code};
use rieul_daemon_core::generated::rpc::*;
use rieul_daemon_host::desktop::{
    Backend, EncodedFrame, Error, MAX_FRAME, MAX_STREAM, MAX_VIEWPORTS, PROFILE,
};
use std::{
    collections::BTreeSet,
    sync::mpsc::{self, SyncSender},
    time::{Duration, Instant},
};
enum Command {
    Recover(Vec<u64>, Vec<u64>),
    Capabilities,
    Probe(DesktopTrack),
    Displays,
    Cursor(u64),
    Input(DesktopInputEvent, Option<DesktopViewport>),
}
enum Reply {
    Probe(DesktopQualityVerification),
    Cursor(DesktopEvent),
    Capabilities(DesktopCapabilities),
    Displays(Vec<DesktopDisplay>),
    Done,
}
struct Request {
    command: Command,
    deadline: Instant,
    reply: SyncSender<Result<Reply, Error>>,
}
pub struct WindowsDesktop {
    sender: Option<SyncSender<Request>>,
    worker: Option<std::thread::JoinHandle<()>>,
    captures: crate::desktop_capture::Captures,
}
impl Drop for WindowsDesktop {
    fn drop(&mut self) {
        drop(self.sender.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl WindowsDesktop {
    pub fn for_user_session() -> Result<Self, Error> {
        if !native::interactive() {
            return Err(Error::Unauthorized);
        }
        let (sender, receiver) = mpsc::sync_channel::<Request>(2);
        let worker = std::thread::Builder::new()
            .name("rieul-desktop-user".into())
            .spawn(move || {
                let Ok(_apartment) = native::Apartment::enter() else {
                    return;
                };
                let mut state = Worker::default();
                while let Ok(request) = receiver.recv() {
                    if Instant::now() >= request.deadline {
                        let _ = request.reply.send(Err(Error::Stale));
                        continue;
                    }
                    let read_only_probe = matches!(&request.command, Command::Probe(_));
                    let result = state.execute(request.command);
                    if request.reply.send(result).is_err() && !read_only_probe {
                        let _ = state.release();
                    }
                }
                let _ = state.release();
            })
            .map_err(|_| Error::Backend)?;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
            captures: Default::default(),
        })
    }
    fn call(&self, command: Command) -> Result<Reply, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or(Error::Backend)?
            .try_send(Request {
                command,
                deadline: Instant::now() + Duration::from_secs(2),
                reply: tx,
            })
            .map_err(|_| Error::Busy)?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| Error::Backend)?
    }
}
fn unavailable(reason: &str) -> DesktopCapabilities {
    DesktopCapabilities {
        supported_profiles: None,
        profile: PROFILE,
        capture: DesktopAvailability::Unsupported,
        input: DesktopAvailability::Unsupported,
        codecs: vec![],
        composition: false,
        relative_pointer: false,
        max_viewports: MAX_VIEWPORTS as u64,
        max_input_frame_bytes: MAX_FRAME as u64,
        max_input_stream_bytes: MAX_STREAM as u64,
        reason: Some(reason.into()),
        feedback: Some(true),
        wheel_units: Some(vec![DesktopWheelUnit::Lines]),
        physical_keys: Some(
            (4..=231)
                .filter(|usage| scan_code(*usage).is_some())
                .collect(),
        ),
    }
}
impl Backend for WindowsDesktop {
    fn probe_video(&self, track: &DesktopTrack) -> DesktopQualityVerification {
        if !rieul_daemon_host::desktop::validate_video_probe(track) {
            return DesktopQualityVerification::Unsupported;
        }
        match self.call(Command::Probe(track.clone())) {
            Ok(Reply::Probe(value)) => value,
            _ => DesktopQualityVerification::Unknown,
        }
    }

    fn recover_input(&self, keys: &[u64], buttons: &[u64]) -> Result<(), Error> {
        match self.call(Command::Recover(keys.to_vec(), buttons.to_vec()))? {
            Reply::Done => Ok(()),
            _ => Err(Error::Backend),
        }
    }

    fn capabilities(&self) -> DesktopCapabilities {
        match self.call(Command::Capabilities) {
            Ok(Reply::Capabilities(c)) => c,
            _ => unavailable("User desktop or hardware encoder is unavailable"),
        }
    }
    fn displays(&self) -> Vec<DesktopDisplay> {
        match self.call(Command::Displays) {
            Ok(Reply::Displays(d)) => d,
            _ => vec![],
        }
    }
    fn cursor(&self, layout: u64) -> Option<DesktopEvent> {
        match self.call(Command::Cursor(layout)) {
            Ok(Reply::Cursor(cursor)) => Some(cursor),
            _ => None,
        }
    }
    fn keyboard_mode_supported(&self, mode: DesktopKeyboardMode) -> bool {
        mode == DesktopKeyboardMode::Physical
    }
    fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
        self.input_viewport(event, None)
    }
    fn input_viewport(
        &self,
        event: &DesktopInputEvent,
        viewport: Option<&DesktopViewport>,
    ) -> Result<(), Error> {
        match self.call(Command::Input(event.clone(), viewport.cloned()))? {
            Reply::Done => Ok(()),
            _ => Err(Error::Backend),
        }
    }
    fn group(&self, t: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
        let mut frames = vec![];
        self.captures.stream(t, false, &mut |f| {
            frames.push(f);
            Ok(())
        })?;
        Ok(frames)
    }
    fn stream_group_with_refresh(
        &self,
        t: &DesktopTrack,
        refresh: bool,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.captures.stream(t, refresh, emit)
    }
    fn stream_group_at_rate(
        &self,
        t: &DesktopTrack,
        refresh: bool,
        bitrate: u64,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.captures.stream_at_rate(t, refresh, bitrate, emit)
    }
    fn end_track(&self, t: &DesktopTrack) -> Result<(), Error> {
        self.captures.end(t)
    }
}

struct Worker {
    keys: BTreeSet<u64>,
    buttons: BTreeSet<u64>,
    point: (i32, i32),
    codecs: Vec<String>,
    probed: bool,
    stripes: bool,
    stripes_probed: bool,
    wheel: (f64, f64),
}
impl Default for Worker {
    fn default() -> Self {
        Self {
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            point: (0, 0),
            codecs: vec![],
            probed: false,
            stripes: false,
            stripes_probed: false,
            wheel: (0.0, 0.0),
        }
    }
}
impl Worker {
    fn execute(&mut self, command: Command) -> Result<Reply, Error> {
        if !native::interactive() {
            return Err(Error::Unauthorized);
        }
        match command {
            Command::Probe(track) => {
                if !rieul_daemon_host::desktop::validate_video_probe(&track) {
                    return Ok(Reply::Probe(DesktopQualityVerification::Unsupported));
                }
                if track.stripes.is_some() {
                    return Ok(Reply::Probe(if crate::desktop_capture::probe_stripes(&track) {DesktopQualityVerification::Verified} else {DesktopQualityVerification::Unknown}));
                }
                let format = if track.codec.codec.starts_with("avc1.") {
                    native::Codec::H264
                } else if track.codec.codec.starts_with("av01.") {
                    native::Codec::Av1
                } else {
                    return Ok(Reply::Probe(DesktopQualityVerification::Unsupported));
                };
                let v = &track.viewport;
                let verified = (|| {
                    let encoder = native::HardwareEncoder::with_codec(
                        v.width as u32,
                        v.height as u32,
                        v.fps as u32,
                        v.bitrate as u32,
                        format,
                    )
                    .ok()?;
                    let mut pixels = vec![128; (v.width * v.height * 3 / 2) as usize];
                    pixels[..(v.width * v.height) as usize].fill(16);
                    let packet = encoder.encode_keyframe(&pixels, 0).ok()?;
                    if format == native::Codec::Av1 {
                        crate::desktop_pixels::av1_independent(&packet, &mut vec![])
                            .map(|(codec, _)| codec)
                    } else {
                        avc_codec(&packet)
                    }
                })();
                Ok(Reply::Probe(
                    if verified.as_deref() == Some(track.codec.codec.as_str()) {
                        DesktopQualityVerification::Verified
                    } else {
                        DesktopQualityVerification::Unknown
                    },
                ))
            }
            Command::Recover(keys, buttons) => {
                self.keys.extend(keys);
                self.buttons.extend(buttons);
                self.release()?;
                Ok(Reply::Done)
            }
            Command::Capabilities => {
                if !self.probed {
                    self.probed = true;
                    for format in [native::Codec::H264, native::Codec::Av1] {
                        let Ok(encoder) =
                            native::HardwareEncoder::with_codec(640, 480, 60, 2_000_000, format)
                        else {
                            continue;
                        };
                        let mut pixels = vec![128; 640 * 480 * 3 / 2];
                        pixels[..640 * 480].fill(16);
                        let Ok(packet) = encoder.encode_keyframe(&pixels, 0) else {
                            continue;
                        };
                        let codec = if format == native::Codec::Av1 {
                            crate::desktop_pixels::av1_independent(&packet, &mut vec![])
                                .map(|(codec, _)| codec)
                        } else {
                            avc_codec(&packet)
                        };
                        if let Some(codec) = codec {
                            self.codecs.push(codec);
                        }
                    }
                }
                if !self.stripes_probed {
                    self.stripes_probed=true;
                    if let Some(codec)=self.codecs.iter().find(|c|c.starts_with("avc1.")) {
                        let track=DesktopTrack {
                            codec: DesktopCodec{codec:codec.clone(),hardware:true,description:None},
                            viewport: DesktopViewport{width:640,height:480,fps:60,bitrate:2_000_000,..Default::default()},
                            stripes: rieul_daemon_core::desktop_stripe::layout(480,2),
                            ..Default::default()
                        };
                        self.stripes=crate::desktop_capture::probe_stripes(&track);
                    }
                }
                let mut caps =
                    unavailable("No hardware encoder produced a supported independent keyframe");
                if !self.codecs.is_empty() {
                    caps.supported_profiles=Some(if self.stripes {vec![1,2]} else {vec![1]});
                    caps.capture = DesktopAvailability::Available;
                    caps.input = DesktopAvailability::Available;
                    caps.reason=Some("Physical keys and line-unit wheel only; IME, pixel/page wheel, rotated displays and secure desktops are unavailable".into());
                    caps.codecs = self
                        .codecs
                        .iter()
                        .map(|codec| DesktopCodec {
                            codec: codec.clone(),
                            description: None,
                            hardware: true,
                        })
                        .collect();
                }
                Ok(Reply::Capabilities(caps))
            }
            Command::Cursor(layout) => {
                let c = native::cursor().map_err(|_| Error::Backend)?;
                let display = native::displays()
                    .map_err(|_| Error::Backend)?
                    .into_iter()
                    .find(|d| {
                        c.x >= d.x
                            && c.y >= d.y
                            && c.x < d.x + d.width as i32
                            && c.y < d.y + d.height as i32
                    })
                    .map(|d| d.id);
                Ok(Reply::Cursor(DesktopEvent::Cursor {
                    layout_epoch: layout,
                    x: c.x as i64,
                    y: c.y as i64,
                    visible: c.visible,
                    shape: c.shape,
                    hotspot_x: c.hotspot.0 as u64,
                    hotspot_y: c.hotspot.1 as u64,
                    display_id: display,
                }))
            }
            Command::Displays => Ok(Reply::Displays(
                native::displays()
                    .map_err(|_| Error::Backend)?
                    .into_iter()
                    .map(|d| DesktopDisplay {
                        display_id: d.id,
                        bounds: DesktopRect {
                            x: d.x as i64,
                            y: d.y as i64,
                            width: d.width as u64,
                            height: d.height as u64,
                        },
                        scale: d.scale,
                        dpi: 96.0 * d.scale,
                    })
                    .collect(),
            )),
            Command::Input(event, viewport) => {
                self.input(event, viewport)?;
                Ok(Reply::Done)
            }
        }
    }
    fn release(&mut self) -> Result<(), Error> {
        let mut failed = false;
        for usage in self.keys.clone() {
            if let Some((scan, e0)) = scan_code(usage) {
                if native::key(scan, e0, false).is_ok() {
                    self.keys.remove(&usage);
                } else {
                    failed = true;
                }
            }
        }
        for button in self.buttons.clone() {
            if native::mouse(self.point.0, self.point.1, Some((button, false))).is_ok() {
                self.buttons.remove(&button);
            } else {
                failed = true;
            }
        }
        if failed { Err(Error::Backend) } else { Ok(()) }
    }
    fn input(
        &mut self,
        event: DesktopInputEvent,
        viewport: Option<DesktopViewport>,
    ) -> Result<(), Error> {
        if viewport.is_none()
            && matches!(
                event,
                DesktopInputEvent::AbsolutePointer { .. }
                    | DesktopInputEvent::Button { down: true, .. }
                    | DesktopInputEvent::Wheel { .. }
            )
        {
            return Err(Error::Invalid);
        }
        if let Some(v) = viewport {
            let d = native::displays()
                .map_err(|_| Error::Backend)?
                .into_iter()
                .find(|d| d.id == v.display_id)
                .ok_or(Error::Stale)?;
            let (x, y) = match event {
                DesktopInputEvent::AbsolutePointer { x, y, .. }
                | DesktopInputEvent::Button { x, y, .. }
                | DesktopInputEvent::Wheel { x, y, .. } => (x, y),
                _ => return Err(Error::Invalid),
            };
            if v.width == 0
                || v.height == 0
                || !x.is_finite()
                || !y.is_finite()
                || x < 0.0
                || y < 0.0
                || x >= v.width as f64
                || y >= v.height as f64
                || v.crop.width == 0
                || v.crop.height == 0
                || v.crop.x < 0
                || v.crop.y < 0
                || (v.crop.x as u64).saturating_add(v.crop.width) > d.width as u64
                || (v.crop.y as u64).saturating_add(v.crop.height) > d.height as u64
            {
                return Err(Error::Invalid);
            }
            self.point = (
                d.x + (v.crop.x as f64 + x * v.crop.width as f64 / v.width as f64) as i32,
                d.y + (v.crop.y as f64 + y * v.crop.height as f64 / v.height as f64) as i32,
            );
        }
        match event {
            DesktopInputEvent::PhysicalKey { usage, down, .. } => {
                let (scan, e0) = scan_code(usage).ok_or(Error::Unsupported)?;
                if down {
                    self.keys.insert(usage);
                }
                native::key(scan, e0, down).map_err(|_| Error::Backend)?;
                if !down {
                    self.keys.remove(&usage);
                }
            }
            DesktopInputEvent::AbsolutePointer { .. } => {
                native::mouse(self.point.0, self.point.1, None).map_err(|_| Error::Backend)?
            }
            DesktopInputEvent::Button { button, down, .. } => {
                if down {
                    self.buttons.insert(button);
                }
                native::mouse(self.point.0, self.point.1, Some((button, down)))
                    .map_err(|_| Error::Backend)?;
                if !down {
                    self.buttons.remove(&button);
                }
            }
            DesktopInputEvent::Wheel { dx, dy, unit, .. } => {
                if unit != DesktopWheelUnit::Lines {
                    return Err(Error::Unsupported);
                }
                let (x_units, y_units) =
                    native::wheel_units_per_line().map_err(|_| Error::Unsupported)?;
                self.wheel.0 += dx * x_units;
                self.wheel.1 += dy * y_units;
                let (x, y) = (self.wheel.0.trunc() as i32, self.wheel.1.trunc() as i32);
                native::wheel(x, y).map_err(|_| Error::Backend)?;
                self.wheel.0 -= x as f64;
                self.wheel.1 -= y as f64;
            }
            DesktopInputEvent::ReleaseAll => self.release()?,
            _ => return Err(Error::Unsupported),
        }
        Ok(())
    }
}
pub(crate) fn avc_codec(bytes: &[u8]) -> Option<String> {
    let mut sps = None;
    let mut pps = false;
    let mut idr = false;
    for i in 0..bytes.len().saturating_sub(6) {
        if bytes[i..].starts_with(&[0, 0, 1]) {
            let kind = bytes[i + 3] & 31;
            match kind {
                7 => {
                    sps = Some(format!(
                        "avc1.{:02x}{:02x}{:02x}",
                        bytes[i + 4],
                        bytes[i + 5],
                        bytes[i + 6]
                    ))
                }
                8 => pps = true,
                5 => idr = true,
                _ => {}
            }
        }
    }
    if pps && idr { sps } else { None }
}
