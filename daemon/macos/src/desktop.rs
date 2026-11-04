//! ScreenCaptureKit + hardware VideoToolbox, for a verified interactive user helper.
//! Deliberately not constructed by the root system daemon.
use rieul_daemon_core::generated::rpc::*;
use rieul_daemon_host::desktop::{
    Backend, EncodedFrame, Error, MAX_FRAME, MAX_STREAM, MAX_VIEWPORTS, PROFILE,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::c_void,
    sync::{Arc, Mutex},
    time::Instant,
};
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Display {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    dpi: f64,
}
#[repr(C)]
#[derive(Default)]
struct Cursor {
    x: f64,
    y: f64,
    hotspot_x: u32,
    hotspot_y: u32,
    visible: bool,
}
unsafe extern "C" {
    fn rd_pointer_position(x: *mut f64, y: *mut f64) -> bool;
    fn rd_cursor(result: *mut Cursor, png: *mut u8, capacity: usize) -> usize;
    fn rd_permissions() -> i32;
    fn rd_displays(out: *mut Display, capacity: usize) -> usize;
    fn rd_hardware_codec(codec: *mut u32) -> bool;
    fn rd_probe_video(width: u32, height: u32, fps: u32, bitrate: u32, codec: *mut u32) -> bool;
    #[cfg(test)]
    fn rd_av1_hardware_encoder_available() -> bool;
    #[cfg(test)]
    fn rd_synthetic_packet(
        emit: extern "C" fn(*mut c_void, *const u8, usize, u64) -> bool,
        context: *mut c_void,
    ) -> bool;
    fn rd_capture_create(
        id: u32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        shutdown_failed: *mut bool,
    ) -> *mut c_void;
    fn rd_capture_set_bitrate(handle: *mut c_void, bitrate: u32) -> bool;
    fn rd_capture_destroy(handle: *mut c_void) -> bool;
    fn rd_capture_next(
        handle: *mut c_void,
        timestamp: u64,
        key: bool,
        refresh: bool,
        emit: extern "C" fn(*mut c_void, *const u8, usize, u64) -> bool,
        context: *mut c_void,
    ) -> i32;
    fn rd_key(code: u16, down: bool, repeat: bool, flags: u64) -> bool;
    fn rd_mouse(kind: u32, button: u32, x: f64, y: f64, flags: u64) -> bool;
    fn rd_wheel(x: i32, y: i32, pixels: bool) -> bool;
}
struct Capture(*mut c_void);
// Access is serialized by tracks; the ObjC capture delegate owns its queue/lock.
unsafe impl Send for Capture {}
impl Drop for Capture {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                rd_capture_destroy(self.0);
            }
        }
    }
}
#[derive(Default)]
struct InputState {
    keys: BTreeSet<u64>,
    buttons: BTreeSet<u64>,
    point: (f64, f64),
    wheel: (f64, f64),
    wheel_unit: Option<DesktopWheelUnit>,
}
impl InputState {
    fn flags(&self) -> u64 {
        [
            (224, 228, 1 << 18),
            (225, 229, 1 << 17),
            (226, 230, 1 << 19),
            (227, 231, 1 << 20),
        ]
        .into_iter()
        .filter(|(a, b, _)| self.keys.contains(a) || self.keys.contains(b))
        .map(|(_, _, flag)| flag)
        .sum()
    }
}
pub struct MacDesktop {
    shutdown_uncertain: std::sync::atomic::AtomicBool,
    tracks: Mutex<BTreeMap<(u64, u64), Arc<Mutex<Capture>>>>,
    input: Mutex<InputState>,
    clock: Instant,
}
impl MacDesktop {
    /// Caller must be the authenticated per-user IPC helper, never a root service.
    pub fn for_user_session() -> Result<Self, Error> {
        if unsafe { libc::geteuid() } == 0 {
            return Err(Error::Unauthorized);
        }
        Ok(Self {
            shutdown_uncertain: Default::default(),
            tracks: Mutex::new(BTreeMap::new()),
            input: Mutex::new(InputState::default()),
            clock: Instant::now(),
        })
    }
    fn native_displays(&self) -> Vec<Display> {
        let mut displays = [Display::default(); 32];
        let count = unsafe { rd_displays(displays.as_mut_ptr(), displays.len()) };
        displays[..count.min(displays.len())].to_vec()
    }
    fn inject(
        &self,
        event: &DesktopInputEvent,
        viewport: Option<&DesktopViewport>,
    ) -> Result<(), Error> {
        let mut state = self.input.lock().map_err(|_| Error::Backend)?;
        if unsafe { rd_permissions() } & 2 == 0 {
            return Err(Error::Unauthorized);
        }
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
            let d = self
                .native_displays()
                .into_iter()
                .find(|d| d.id.to_string() == v.display_id)
                .ok_or(Error::Stale)?;
            let (x, y) = match event {
                DesktopInputEvent::AbsolutePointer { x, y, .. }
                | DesktopInputEvent::Button { x, y, .. }
                | DesktopInputEvent::Wheel { x, y, .. } => (*x, *y),
                _ => return Err(Error::Invalid),
            };
            state.point = map_point(v, &d, x, y)?;
        }
        let mut ok = true;
        match event {
            DesktopInputEvent::PhysicalKey {
                usage,
                down,
                repeat,
            } => {
                let code = key_code(*usage).ok_or(Error::Unsupported)?;
                if *down {
                    state.keys.insert(*usage);
                } else {
                    state.keys.remove(usage);
                }
                ok = unsafe { rd_key(code, *down, *repeat, state.flags()) };
                if !ok && !down {
                    state.keys.insert(*usage);
                }
            }
            DesktopInputEvent::AbsolutePointer { .. } => {
                let button = state.buttons.iter().next().copied().unwrap_or(0);
                let (kind, button) = match button {
                    1 => (6, 0),
                    2 => (7, 1),
                    3..=5 => (27, (button - 1) as u32),
                    _ => (5, 0),
                };
                ok = unsafe { rd_mouse(kind, button, state.point.0, state.point.1, state.flags()) };
            }
            DesktopInputEvent::Button { button, down, .. } => {
                if !(1..=5).contains(button) {
                    return Err(Error::Invalid);
                }
                if *down {
                    state.buttons.insert(*button);
                } else {
                    state.buttons.remove(button);
                }
                let kind = match (*button, *down) {
                    (1, true) => 1,
                    (1, false) => 2,
                    (2, true) => 3,
                    (2, false) => 4,
                    (_, true) => 25,
                    _ => 26,
                };
                ok = unsafe {
                    rd_mouse(
                        kind,
                        (*button - 1) as u32,
                        state.point.0,
                        state.point.1,
                        state.flags(),
                    )
                };
                if !ok && !down {
                    state.buttons.insert(*button);
                }
            }
            DesktopInputEvent::Wheel { dx, dy, unit, .. } => {
                if *unit == DesktopWheelUnit::Pages {
                    return Err(Error::Unsupported);
                }
                if state.wheel_unit != Some(*unit) {
                    state.wheel = (0.0, 0.0);
                    state.wheel_unit = Some(*unit);
                }
                state.wheel.0 -= dx;
                state.wheel.1 -= dy;
                let x = state.wheel.0.trunc() as i32;
                let y = state.wheel.1.trunc() as i32;
                state.wheel.0 -= x as f64;
                state.wheel.1 -= y as f64;
                if x != 0 || y != 0 {
                    ok = unsafe { rd_wheel(x, y, *unit == DesktopWheelUnit::Pixels) };
                }
            }
            DesktopInputEvent::ReleaseAll => {
                let keys = std::mem::take(&mut state.keys);
                let buttons = std::mem::take(&mut state.buttons);
                // Attempt all releases even if one fails; manager will poison on failure.
                for usage in keys {
                    if let Some(code) = key_code(usage) {
                        let released = unsafe { rd_key(code, false, false, 0) };
                        ok &= released;
                        if !released {
                            state.keys.insert(usage);
                        }
                    }
                }
                for button in buttons {
                    let kind = match button {
                        1 => 2,
                        2 => 4,
                        _ => 26,
                    };
                    let released = unsafe {
                        rd_mouse(kind, (button - 1) as u32, state.point.0, state.point.1, 0)
                    };
                    ok &= released;
                    if !released {
                        state.buttons.insert(button);
                    }
                }
                state.wheel = (0.0, 0.0);
            }
            _ => return Err(Error::Unsupported),
        }
        if ok { Ok(()) } else { Err(Error::Backend) }
    }
}
fn map_point(v: &DesktopViewport, d: &Display, x: f64, y: f64) -> Result<(f64, f64), Error> {
    if v.width == 0
        || v.height == 0
        || d.scale <= 0.0
        || !d.scale.is_finite()
        || !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x >= v.width as f64
        || y >= v.height as f64
        || v.crop.x < 0
        || v.crop.y < 0
        || v.crop.x as f64 + v.crop.width as f64 > d.width
        || v.crop.y as f64 + v.crop.height as f64 > d.height
    {
        return Err(Error::Invalid);
    }
    Ok((
        d.x + (v.crop.x as f64 + x * v.crop.width as f64 / v.width as f64) / d.scale,
        d.y + (v.crop.y as f64 + y * v.crop.height as f64 / v.height as f64) / d.scale,
    ))
}
impl Backend for MacDesktop {
    fn probe_video(&self, track: &DesktopTrack) -> DesktopQualityVerification {
        if !rieul_daemon_host::desktop::validate_video_probe(track)
            || !track.codec.codec.starts_with("avc1.")
        {
            return DesktopQualityVerification::Unsupported;
        }
        let v = &track.viewport;
        let mut codec = 0;
        if unsafe {
            rd_probe_video(
                v.width as u32,
                v.height as u32,
                v.fps as u32,
                v.bitrate as u32,
                &mut codec,
            )
        } && format!("avc1.{codec:06x}").eq_ignore_ascii_case(&track.codec.codec)
        {
            DesktopQualityVerification::Verified
        } else {
            DesktopQualityVerification::Unknown
        }
    }

    fn recover_input(&self, keys: &[u64], buttons: &[u64]) -> Result<(), Error> {
        if keys.is_empty() && buttons.is_empty() {
            return Ok(());
        }
        {
            let mut state = self.input.lock().map_err(|_| Error::Backend)?;
            if !buttons.is_empty() {
                let (mut x, mut y) = (0.0, 0.0);
                if !unsafe { rd_pointer_position(&mut x, &mut y) } {
                    return Err(Error::Backend);
                }
                state.point = (x, y);
            }
            state.keys.extend(keys.iter().copied());
            state.buttons.extend(buttons.iter().copied());
        }
        self.inject(&DesktopInputEvent::ReleaseAll, None)
    }

    fn capabilities(&self) -> DesktopCapabilities {
        let permissions = unsafe { rd_permissions() };
        let mut codec = 0;
        let hardware = permissions & 1 != 0 && unsafe { rd_hardware_codec(&mut codec) };
        DesktopCapabilities {
            profile: PROFILE,
            feedback: Some(true),
            wheel_units: Some(vec![DesktopWheelUnit::Pixels, DesktopWheelUnit::Lines]),
            physical_keys: Some(
                (4..=231)
                    .filter(|usage| key_code(*usage).is_some())
                    .collect(),
            ),
            capture: if permissions & 1 == 0 {
                DesktopAvailability::PermissionRequired
            } else if hardware {
                DesktopAvailability::Available
            } else {
                DesktopAvailability::Unsupported
            },
            input: if permissions & 2 != 0 {
                DesktopAvailability::Available
            } else {
                DesktopAvailability::PermissionRequired
            },
            codecs: if hardware {
                vec![DesktopCodec {
                    codec: format!("avc1.{codec:06x}"),
                    description: None,
                    hardware: true,
                }]
            } else {
                vec![]
            },
            composition: false,
            relative_pointer: false,
            max_viewports: MAX_VIEWPORTS as u64,
            max_input_frame_bytes: MAX_FRAME as u64,
            max_input_stream_bytes: MAX_STREAM as u64,
            reason: (!hardware).then(|| {
                "Screen Recording permission and a hardware H.264 encoder are required".into()
            }),
        }
    }
    fn displays(&self) -> Vec<DesktopDisplay> {
        self.native_displays()
            .into_iter()
            .map(|d| DesktopDisplay {
                display_id: d.id.to_string(),
                bounds: DesktopRect {
                    x: d.x as i64,
                    y: d.y as i64,
                    width: d.width as u64,
                    height: d.height as u64,
                },
                scale: d.scale,
                dpi: d.dpi,
            })
            .collect()
    }
    fn cursor(&self, layout: u64) -> Option<DesktopEvent> {
        let mut cursor = Cursor::default();
        let mut shape = vec![0; 128 * 1024];
        let length = unsafe { rd_cursor(&mut cursor, shape.as_mut_ptr(), shape.len()) };
        shape.truncate(length.min(shape.len()));
        let display = self.native_displays().into_iter().find(|d| {
            cursor.x >= d.x
                && cursor.y >= d.y
                && cursor.x < d.x + d.width / d.scale
                && cursor.y < d.y + d.height / d.scale
        })?;
        Some(DesktopEvent::Cursor {
            layout_epoch: layout,
            x: (display.x + (cursor.x - display.x) * display.scale) as i64,
            y: (display.y + (cursor.y - display.y) * display.scale) as i64,
            visible: cursor.visible,
            shape: (!shape.is_empty()).then_some(shape),
            hotspot_x: cursor.hotspot_x as u64,
            hotspot_y: cursor.hotspot_y as u64,
            display_id: Some(display.id.to_string()),
        })
    }
    fn keyboard_mode_supported(&self, mode: DesktopKeyboardMode) -> bool {
        mode == DesktopKeyboardMode::Physical
    }
    fn input(&self, event: &DesktopInputEvent) -> Result<(), Error> {
        self.inject(event, None)
    }
    fn input_viewport(
        &self,
        event: &DesktopInputEvent,
        viewport: Option<&DesktopViewport>,
    ) -> Result<(), Error> {
        self.inject(event, viewport)
    }
    fn end_track(&self, track: &DesktopTrack) -> Result<(), Error> {
        let capture = self
            .tracks
            .lock()
            .map_err(|_| Error::Backend)?
            .remove(&(track.track_id, track.codec_epoch));
        if let Some(capture) = capture {
            let mut capture = capture.lock().map_err(|_| Error::Backend)?;
            let handle = std::mem::replace(&mut capture.0, std::ptr::null_mut());
            if !unsafe { rd_capture_destroy(handle) } {
                self.shutdown_uncertain
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        if self
            .shutdown_uncertain
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            Err(Error::Backend)
        } else {
            Ok(())
        }
    }
    fn group(&self, track: &DesktopTrack) -> Result<Vec<EncodedFrame>, Error> {
        let mut frames = vec![];
        self.stream_group_with_refresh(track, false, &mut |f| {
            frames.push(f);
            Ok(())
        })?;
        Ok(frames)
    }
    fn stream_group(
        &self,
        track: &DesktopTrack,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.stream_group_with_refresh(track, false, emit)
    }
    fn stream_group_with_refresh(
        &self,
        track: &DesktopTrack,
        refresh: bool,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.stream_group_at_rate(track, refresh, track.viewport.bitrate, emit)
    }
    fn stream_group_at_rate(
        &self,
        track: &DesktopTrack,
        refresh: bool,
        bitrate: u64,
        emit: &mut dyn FnMut(EncodedFrame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        rieul_daemon_host::desktop::validate_encoder_rate(track, bitrate)?;
        if !track.codec.codec.starts_with("avc1.42") {
            return Err(Error::Unsupported);
        }
        let capture = {
            let mut tracks = self.tracks.lock().map_err(|_| Error::Backend)?;
            let key = (track.track_id, track.codec_epoch);
            let v = &track.viewport;
            if !tracks.contains_key(&key) {
                if tracks.len() >= 32 {
                    return Err(Error::Limit);
                }
                let d = self
                    .native_displays()
                    .into_iter()
                    .find(|d| d.id.to_string() == v.display_id)
                    .ok_or(Error::Stale)?;
                map_point(v, &d, 0.0, 0.0)?;
                let mut shutdown_failed = false;
                let handle = unsafe {
                    rd_capture_create(
                        d.id,
                        v.crop.x as f64,
                        v.crop.y as f64,
                        v.crop.width as f64,
                        v.crop.height as f64,
                        v.width.try_into().map_err(|_| Error::Limit)?,
                        v.height.try_into().map_err(|_| Error::Limit)?,
                        v.fps.try_into().map_err(|_| Error::Limit)?,
                        v.bitrate.try_into().map_err(|_| Error::Limit)?,
                        &mut shutdown_failed,
                    )
                };
                if shutdown_failed {
                    self.shutdown_uncertain
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
                if handle.is_null() {
                    return Err(Error::Backend);
                }
                tracks.insert(key, Arc::new(Mutex::new(Capture(handle))));
            }
            tracks[&key].clone()
        };
        let capture = capture.lock().map_err(|_| Error::Backend)?;
        if capture.0.is_null() {
            return Err(Error::Stale);
        }
        // Unsupported dynamic properties retain the encoder and transport pacing.
        unsafe {
            rd_capture_set_bitrate(capture.0, bitrate as u32);
        }
        struct Packet {
            frame: Option<EncodedFrame>,
            key: bool,
        }
        extern "C" fn packet(context: *mut c_void, data: *const u8, len: usize, time: u64) -> bool {
            if len == 0 || len > 4 * 1024 * 1024 || data.is_null() {
                return false;
            }
            let p = unsafe { &mut *(context as *mut Packet) };
            p.frame = Some(EncodedFrame::new(
                time,
                p.key,
                unsafe { std::slice::from_raw_parts(data, len) }.to_vec(),
            ));
            true
        }
        for index in 0..4 {
            let mut p = Packet {
                frame: None,
                key: index == 0,
            };
            let result = unsafe {
                rd_capture_next(
                    capture.0,
                    self.clock.elapsed().as_micros() as u64,
                    index == 0,
                    refresh && index == 0,
                    packet,
                    &mut p as *mut _ as *mut c_void,
                )
            };
            if result < 0 {
                return Err(Error::Backend);
            }
            if result == 0 {
                break;
            }
            emit(p.frame.ok_or(Error::Backend)?)?;
        }
        Ok(())
    }
}
// USB HID usage -> Apple virtual key code. Unmapped usages fail, never guess by text.
fn key_code(usage: u64) -> Option<u16> {
    let code = match usage {
        4 => 0,
        5 => 11,
        6 => 8,
        7 => 2,
        8 => 14,
        9 => 3,
        10 => 5,
        11 => 4,
        12 => 34,
        13 => 38,
        14 => 40,
        15 => 37,
        16 => 46,
        17 => 45,
        18 => 31,
        19 => 35,
        20 => 12,
        21 => 15,
        22 => 1,
        23 => 17,
        24 => 32,
        25 => 9,
        26 => 13,
        27 => 7,
        28 => 16,
        29 => 6,
        30 => 18,
        31 => 19,
        32 => 20,
        33 => 21,
        34 => 23,
        35 => 22,
        36 => 26,
        37 => 28,
        38 => 25,
        39 => 29,
        40 => 36,
        41 => 53,
        42 => 51,
        43 => 48,
        44 => 49,
        45 => 27,
        46 => 24,
        47 => 33,
        48 => 30,
        49 => 42,
        51 => 41,
        52 => 39,
        53 => 50,
        54 => 43,
        55 => 47,
        56 => 44,
        57 => 57,
        58 => 122,
        59 => 120,
        60 => 99,
        61 => 118,
        62 => 96,
        63 => 97,
        64 => 98,
        65 => 100,
        66 => 101,
        67 => 109,
        68 => 103,
        69 => 111,
        73 => 114,
        74 => 115,
        75 => 116,
        76 => 117,
        77 => 119,
        78 => 121,
        79 => 124,
        80 => 123,
        81 => 125,
        82 => 126,
        83 => 71,
        84 => 75,
        85 => 67,
        86 => 78,
        87 => 69,
        88 => 76,
        89 => 83,
        90 => 84,
        91 => 85,
        92 => 86,
        93 => 87,
        94 => 88,
        95 => 89,
        96 => 91,
        97 => 92,
        98 => 82,
        99 => 65,
        100 => 10,
        224 => 59,
        225 => 56,
        226 => 58,
        227 => 55,
        228 => 62,
        229 => 60,
        230 => 61,
        231 => 54,
        _ => return None,
    };
    Some(code)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "synthetic VideoToolbox hardware probe; no screen capture or input"]
    fn synthetic_hardware_codec() {
        let mut codec = 0;
        assert!(unsafe { rd_hardware_codec(&mut codec) });
        assert_eq!(codec >> 16, 66);
        assert_eq!(codec & 255, 42);
    }
    #[test]
    #[ignore = "exact synthetic hardware encoder targets only; no screen capture/input"]
    fn synthetic_quality_combinations() {
        for (width, height, fps, bitrate) in [
            (1280, 720, 15, 2_000_000),
            (1280, 720, 30, 5_000_000),
            (1920, 1080, 60, 20_000_000),
        ] {
            let mut codec = 0;
            assert!(
                unsafe { rd_probe_video(width, height, fps, bitrate, &mut codec) },
                "{width}x{height} {fps}fps {bitrate}"
            );
            assert_eq!(codec >> 16, 66);
            assert_eq!(codec & 255, 42);
        }
        let mut codec = 0;
        assert!(!unsafe { rd_probe_video(4097, 720, 60, 20_000_000, &mut codec) });
    }
    #[test]
    #[ignore = "synthetic short-GOP hardware export; no screen capture/input"]
    fn export_synthetic_hardware_groups() {
        extern "C" {
            fn rd_synthetic_groups(
                emit: extern "C" fn(*mut c_void, *const u8, usize, u64) -> bool,
                context: *mut c_void,
            ) -> bool;
        }
        extern "C" fn packet(
            context: *mut c_void,
            data: *const u8,
            len: usize,
            timestamp: u64,
        ) -> bool {
            if data.is_null() || len > 4 * 1024 * 1024 {
                return false;
            }
            unsafe {
                let out = &mut *(context as *mut Vec<serde_json::Value>);
                out.push(serde_json::json!({"timestampMicros":timestamp,"keyframe":out.len()%4==0,"data":std::slice::from_raw_parts(data,len)}));
            }
            true
        }
        let mut frames = Vec::<serde_json::Value>::new();
        assert!(unsafe { rd_synthetic_groups(packet, &mut frames as *mut _ as *mut c_void) });
        assert_eq!(frames.len(), 12);
        if let Ok(path) = std::env::var("RIEUL_DESKTOP_SYNTHETIC_GROUPS_OUT") {
            std::fs::write(path, serde_json::to_vec(&frames).unwrap()).unwrap();
        }
    }
    #[test]
    #[ignore = "synthetic hardware bitstream export only; no capture/input"]
    fn export_synthetic_hardware_frame() {
        extern "C" fn packet(context: *mut c_void, data: *const u8, len: usize, _: u64) -> bool {
            if len > 4 * 1024 * 1024 || data.is_null() {
                return false;
            }
            unsafe {
                (&mut *(context as *mut Vec<u8>))
                    .extend_from_slice(std::slice::from_raw_parts(data, len));
            }
            true
        }
        let mut data = Vec::<u8>::new();
        assert!(unsafe { rd_synthetic_packet(packet, &mut data as *mut _ as *mut c_void) });
        assert!(!data.is_empty());
        if let Ok(path) = std::env::var("RIEUL_DESKTOP_SYNTHETIC_OUT") {
            std::fs::write(path, data).unwrap();
        }
    }
    #[test]
    #[ignore = "hardware encoder session availability only; no capture or input"]
    fn av1_hardware_encoder_availability() {
        eprintln!(
            "VideoToolbox hardware AV1 encoder session available: {}",
            unsafe { rd_av1_hardware_encoder_available() }
        );
    }
    #[test]
    fn physical_side_and_keypad_mapping() {
        assert_eq!(
            (key_code(224), key_code(228), key_code(40), key_code(88)),
            (Some(59), Some(62), Some(36), Some(76))
        );
        assert_eq!(key_code(200), None);
    }
    #[test]
    fn flags_preserve_other_side() {
        let mut s = InputState::default();
        s.keys.extend([224, 228]);
        s.keys.remove(&224);
        assert_eq!(s.flags(), 1 << 18);
    }
    #[test]
    fn crop_pixels_transform_into_global_points() {
        let v = DesktopViewport {
            viewport_id: "v".into(),
            display_id: "1".into(),
            crop: DesktopRect {
                x: 100,
                y: 200,
                width: 800,
                height: 600,
            },
            width: 400,
            height: 300,
            fps: 60,
            bitrate: 1000,
        };
        let d = Display {
            id: 1,
            x: -1000.0,
            y: 100.0,
            width: 2000.0,
            height: 1600.0,
            scale: 2.0,
            dpi: 200.0,
        };
        assert_eq!(map_point(&v, &d, 100.0, 50.0).unwrap(), (-850.0, 250.0));
        assert!(map_point(&v, &d, f64::NAN, 0.0).is_err());
    }
}

impl Drop for MacDesktop {
    fn drop(&mut self) {
        let _ = self.inject(&DesktopInputEvent::ReleaseAll, None);
    }
}
