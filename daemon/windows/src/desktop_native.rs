//! Native user-session primitives. Constructors perform capture only when called
//! explicitly by the desktop helper; no service startup path constructs these.
use std::{
    mem::{ManuallyDrop, size_of},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::*,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
        Media::MediaFoundation::*,
        System::{Com::*, Variant::VARIANT},
        UI::Input::KeyboardAndMouse::*,
    },
    core::{Error, HRESULT, Interface, Result},
};
fn invalid() -> Error {
    Error::from_hresult(HRESULT(0x80070057u32 as i32))
}
/// Keep this guard and all native objects on their owning worker thread.
pub struct Apartment(
    std::marker::PhantomData<std::rc::Rc<()>>,
    windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT,
);
impl Apartment {
    pub fn enter() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(e);
            }
        }
        let previous = unsafe {
            windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            )
        };
        if previous.0.is_null() {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
            return Err(invalid());
        }
        Ok(Self(std::marker::PhantomData, previous))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(self.1);
            CoUninitialize();
        }
    }
}
pub struct CapturedBgra {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bytes: Vec<u8>,
}
pub struct Duplication {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    pub bounds: windows::Win32::Foundation::RECT,
}
impl Duplication {
    pub fn open(adapter_index: u32, output_index: u32) -> Result<Self> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter = factory.EnumAdapters1(adapter_index)?;
            let output = adapter.EnumOutputs(output_index)?;
            let description = output.GetDesc()?;
            // Rotation needs an explicit transform; never advertise an unrotated view.
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.ok_or_else(invalid)?;
            let context = context.ok_or_else(invalid)?;
            let output: IDXGIOutput1 = output.cast()?;
            let duplication = output.DuplicateOutput(&device)?;
            let desc = duplication.GetDesc();
            if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY {
                return Err(invalid());
            }
            Ok(Self {
                device,
                context,
                duplication,
                bounds: description.DesktopCoordinates,
            })
        }
    }
    pub fn next(&self) -> Result<Option<CapturedBgra>> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            if let Err(e) = self
                .duplication
                .AcquireNextFrame(100, &mut info, &mut resource)
            {
                if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    return Ok(None);
                }
                return Err(e);
            }
            struct Release<'a>(&'a IDXGIOutputDuplication);
            impl Drop for Release<'_> {
                fn drop(&mut self) {
                    unsafe {
                        let _ = self.0.ReleaseFrame();
                    }
                }
            }
            let _release = Release(&self.duplication);
            let texture: ID3D11Texture2D = resource.ok_or_else(invalid)?.cast()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            if desc.Width > 8192 || desc.Height > 8192 || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            {
                return Err(invalid());
            }
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            let mut staging = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut staging))?;
            let staging = staging.ok_or_else(invalid)?;
            self.context.CopyResource(&staging, &texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let length = mapped.RowPitch as usize * desc.Height as usize;
            let result = if mapped.pData.is_null()
                || length > 256 * 1024 * 1024
                || mapped.RowPitch < desc.Width * 4
            {
                Err(invalid())
            } else {
                Ok(Some(CapturedBgra {
                    width: desc.Width,
                    height: desc.Height,
                    stride: mapped.RowPitch as usize,
                    bytes: std::slice::from_raw_parts(mapped.pData as *const u8, length).to_vec(),
                }))
            };
            self.context.Unmap(&staging, 0);
            result
        }
    }
}
/// Hardware-only asynchronous Media Foundation encoder. NV12 input, Annex B H.264
/// output, one forced independent keyframe per group in this initial adapter.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Av1,
}
pub struct HardwareEncoder {
    codec: Codec,
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    width: u32,
    height: u32,
    fps: u32,
    credits: std::cell::Cell<u32>,
    headers: std::cell::RefCell<Vec<u8>>,
}
impl HardwareEncoder {
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self> {
        Self::with_codec(width, height, fps, bitrate, Codec::H264)
    }
    pub fn with_codec(
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        format: Codec,
    ) -> Result<Self> {
        unsafe {
            if width == 0
                || height == 0
                || width % 2 != 0
                || height % 2 != 0
                || width > 3840
                || height > 2160
                || fps == 0
                || fps > 120
            {
                return Err(invalid());
            }
            let input = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_NV12,
            };
            let subtype = if format == Codec::Av1 {
                MFVideoFormat_AV1
            } else {
                MFVideoFormat_H264
            };
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: subtype,
            };
            let mut list = std::ptr::null_mut();
            let mut count = 0;
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&input),
                Some(&output),
                &mut list,
                &mut count,
            )?;
            let mut activations = Vec::new();
            if !list.is_null() {
                for i in 0..count {
                    if let Some(item) = list.add(i as usize).read() {
                        activations.push(item);
                    }
                }
                CoTaskMemFree(Some(list.cast()));
            }
            let mut selected = None;
            for activation in activations {
                let attempt = (|| -> Result<Self> {
                    let transform: IMFTransform = activation.ActivateObject()?;
                    let attributes = transform.GetAttributes()?;
                    if attributes.GetUINT32(&MF_TRANSFORM_ASYNC)? == 0 {
                        return Err(invalid());
                    }
                    attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                    attributes.SetUINT32(&MF_LOW_LATENCY, 1)?;
                    let output = media_type(subtype, width, height, fps)?;
                    output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                    output.SetUINT32(
                        &MF_MT_MPEG2_PROFILE,
                        if format == Codec::Av1 { 0 } else { 66 },
                    )?;
                    output.SetUINT32(
                        &MF_MT_MPEG2_LEVEL,
                        if format == Codec::Av1 { 13 } else { 42 },
                    )?;
                    transform.SetOutputType(0, &output, 0)?;
                    transform.SetInputType(
                        0,
                        &media_type(MFVideoFormat_NV12, width, height, fps)?,
                        0,
                    )?;
                    let codec: ICodecAPI = transform.cast()?;
                    codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
                    if format == Codec::H264 {
                        codec.SetValue(
                            &CODECAPI_AVEncMPVDefaultBPictureCount,
                            &VARIANT::from(0u32),
                        )?;
                    }
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                    let events = transform.cast()?;
                    Ok(Self {
                        codec: format,
                        transform,
                        events,
                        width,
                        height,
                        fps,
                        credits: std::cell::Cell::new(0),
                        headers: Default::default(),
                    })
                })();
                match attempt {
                    Ok(value) => {
                        selected = Some(value);
                        break;
                    }
                    Err(_) => {
                        let _ = activation.ShutdownObject();
                    }
                }
            }
            selected.ok_or_else(invalid)
        }
    }
    pub fn encode_keyframe(&self, nv12: &[u8], timestamp_micros: u64) -> Result<Vec<u8>> {
        unsafe {
            let length = self.width as usize * self.height as usize * 3 / 2;
            if nv12.len() != length || timestamp_micros > i64::MAX as u64 / 10 {
                return Err(invalid());
            }
            let until = Instant::now() + Duration::from_millis(500);
            let mut sent = false;
            loop {
                if Instant::now() >= until {
                    return Err(Error::from_hresult(HRESULT(0x800705b4u32 as i32)));
                }
                if !sent && self.credits.get() > 0 {
                    let codec: ICodecAPI = self.transform.cast()?;
                    codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32))?;
                    let buffer = MFCreateMemoryBuffer(length as u32)?;
                    let mut pointer = std::ptr::null_mut();
                    buffer.Lock(&mut pointer, None, None)?;
                    if pointer.is_null() {
                        let _ = buffer.Unlock();
                        return Err(invalid());
                    }
                    std::ptr::copy_nonoverlapping(nv12.as_ptr(), pointer, length);
                    buffer.Unlock()?;
                    buffer.SetCurrentLength(length as u32)?;
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&buffer)?;
                    sample.SetSampleTime((timestamp_micros * 10) as i64)?;
                    sample.SetSampleDuration(10_000_000 / self.fps as i64)?;
                    self.transform.ProcessInput(0, &sample, 0)?;
                    self.credits.set(self.credits.get() - 1);
                    sent = true;
                }
                let event = match self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(e) => e,
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                event.GetStatus()?.ok()?;
                match event.GetType()? {
                    kind if kind == METransformNeedInput.0 as u32 => {
                        self.credits.set(
                            self.credits
                                .get()
                                .checked_add(1)
                                .filter(|n| *n <= 64)
                                .ok_or_else(invalid)?,
                        );
                    }
                    kind if kind == METransformHaveOutput.0 as u32 => {
                        if !sent {
                            return Err(invalid());
                        }
                        let info = self.transform.GetOutputStreamInfo(0)?;
                        let supplied =
                            if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                                let sample = MFCreateSample()?;
                                sample.AddBuffer(&MFCreateMemoryBuffer(
                                    info.cbSize.max(1024 * 1024).min(4 * 1024 * 1024),
                                )?)?;
                                Some(sample)
                            } else {
                                None
                            };
                        let mut output = [MFT_OUTPUT_DATA_BUFFER {
                            dwStreamID: 0,
                            pSample: ManuallyDrop::new(supplied),
                            dwStatus: 0,
                            pEvents: ManuallyDrop::new(None),
                        }];
                        let mut status = 0;
                        let result = self.transform.ProcessOutput(0, &mut output, &mut status);
                        let sample = ManuallyDrop::take(&mut output[0].pSample);
                        drop(ManuallyDrop::take(&mut output[0].pEvents));
                        result?;
                        let sample = sample.ok_or_else(invalid)?;
                        if sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 1 {
                            return Err(invalid());
                        }
                        let buffer = sample.ConvertToContiguousBuffer()?;
                        let length = buffer.GetCurrentLength()? as usize;
                        if length == 0 || length > 4 * 1024 * 1024 {
                            return Err(invalid());
                        }
                        let mut pointer = std::ptr::null_mut();
                        buffer.Lock(&mut pointer, None, None)?;
                        let bytes = if pointer.is_null() {
                            Err(invalid())
                        } else {
                            Ok(std::slice::from_raw_parts(pointer, length).to_vec())
                        };
                        buffer.Unlock()?;
                        let bytes = bytes?;
                        if self.codec == Codec::Av1 {
                            return crate::desktop_pixels::av1_independent(
                                &bytes,
                                &mut self.headers.borrow_mut(),
                            )
                            .map(|(_, packet)| packet)
                            .ok_or_else(invalid);
                        }
                        // Never falsely advertise an arbitrary avcC/length-prefixed payload.
                        if !bytes.starts_with(&[0, 0, 0, 1]) && !bytes.starts_with(&[0, 0, 1]) {
                            return Err(invalid());
                        }
                        let headers = crate::desktop_pixels::annex_b_headers(&bytes);
                        if !headers.is_empty() {
                            *self.headers.borrow_mut() = headers;
                            return Ok(bytes);
                        }
                        if self.headers.borrow().is_empty() {
                            return Err(invalid());
                        }
                        let mut independent = self.headers.borrow().clone();
                        independent.extend_from_slice(&bytes);
                        if independent.len() > 4 * 1024 * 1024 {
                            return Err(invalid());
                        }
                        return Ok(independent);
                    }
                    _ => {}
                }
            }
        }
    }
}
impl Drop for HardwareEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
        }
    }
}
unsafe fn media_type(
    subtype: windows::core::GUID,
    w: u32,
    h: u32,
    fps: u32,
) -> Result<IMFMediaType> {
    let value = MFCreateMediaType()?;
    value.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    value.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
    value.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64)?;
    value.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1)?;
    value.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
    value.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    Ok(value)
}
/// Exact scan-code input; caller checks current interactive desktop and authorization.
pub fn key(scan: u16, extended: bool, down: bool) -> Result<()> {
    unsafe {
        if !interactive() {
            return Err(invalid());
        }
        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: scan,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        if SendInput(&[input], size_of::<INPUT>() as i32) != 1 {
            return Err(Error::from_thread());
        }
        Ok(())
    }
}

/// Reject services, secure desktops and inactive console sessions. Never switch desktops.
pub fn interactive() -> bool {
    use windows::Win32::{
        Foundation::HANDLE,
        System::{
            RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId},
            StationsAndDesktops::*,
            Threading::{GetCurrentProcessId, GetCurrentThreadId},
        },
    };
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session).is_err()
            || session == 0
            || session != WTSGetActiveConsoleSessionId()
        {
            return false;
        }
        let Ok(input) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let name = |desktop: HDESK| {
            let mut buffer = [0u16; 64];
            let mut size = 0;
            GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(buffer.as_mut_ptr().cast()),
                128,
                Some(&mut size),
            )
            .ok()
            .map(|_| {
                String::from_utf16_lossy(
                    &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(64)],
                )
            })
        };
        let current = GetThreadDesktop(GetCurrentThreadId()).ok().and_then(name);
        let active = name(input);
        let _ = CloseDesktop(input);
        active.as_deref() == Some("Default") && current == active
    }
}
#[derive(Clone)]
pub struct Display {
    pub scale: f64,
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
pub fn displays() -> Result<Vec<Display>> {
    unsafe {
        if !interactive() {
            return Err(invalid());
        }
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut displays = Vec::new();
        for a in 0..16 {
            let Ok(adapter) = factory.EnumAdapters1(a) else {
                break;
            };
            for o in 0..16 {
                let Ok(output) = adapter.EnumOutputs(o) else {
                    break;
                };
                let d = output.GetDesc()?;
                if !d.AttachedToDesktop.as_bool() || d.Rotation != DXGI_MODE_ROTATION_IDENTITY {
                    continue;
                }
                let b = d.DesktopCoordinates;
                let scale = windows::Win32::UI::Shell::GetScaleFactorForMonitor(d.Monitor)?.0
                    as f64
                    / 100.0;
                if !(0.5..=5.0).contains(&scale) {
                    return Err(invalid());
                }
                displays.push(Display {
                    scale,
                    id: format!("{a}.{o}"),
                    x: b.left,
                    y: b.top,
                    width: (b.right - b.left) as u32,
                    height: (b.bottom - b.top) as u32,
                });
            }
        }
        Ok(displays)
    }
}
pub fn mouse(x: i32, y: i32, button: Option<(u64, bool)>) -> Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        if !interactive() {
            return Err(invalid());
        }
        let mut inputs = Vec::new();
        if button.is_none() || button.is_some_and(|(_, down)| down) {
            let (left, top, w, h) = (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            );
            if w <= 1 || h <= 1 {
                return Err(invalid());
            }
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: (((x - left) as i64 * 65535) / (w - 1) as i64).clamp(0, 65535) as i32,
                        dy: (((y - top) as i64 * 65535) / (h - 1) as i64).clamp(0, 65535) as i32,
                        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        ..Default::default()
                    },
                },
            });
        }
        if let Some((button, down)) = button {
            let (flags, data) = match (button, down) {
                (1, true) => (MOUSEEVENTF_LEFTDOWN, 0),
                (1, false) => (MOUSEEVENTF_LEFTUP, 0),
                (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
                (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
                (3, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
                (3, false) => (MOUSEEVENTF_MIDDLEUP, 0),
                (4, true) => (MOUSEEVENTF_XDOWN, 1),
                (4, false) => (MOUSEEVENTF_XUP, 1),
                (5, true) => (MOUSEEVENTF_XDOWN, 2),
                (5, false) => (MOUSEEVENTF_XUP, 2),
                _ => return Err(invalid()),
            };
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: flags,
                        mouseData: data,
                        ..Default::default()
                    },
                },
            });
        }
        if SendInput(&inputs, size_of::<INPUT>() as i32) != inputs.len() as u32 {
            return Err(Error::from_thread());
        }
        Ok(())
    }
}
pub fn wheel(x: i32, y: i32) -> Result<()> {
    unsafe {
        if !interactive() {
            return Err(invalid());
        }
        let mut inputs = Vec::new();
        for (delta, flag) in [(x, MOUSEEVENTF_HWHEEL), (-y, MOUSEEVENTF_WHEEL)] {
            if delta != 0 {
                inputs.push(INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: flag,
                            mouseData: delta as u32,
                            ..Default::default()
                        },
                    },
                });
            }
        }
        if SendInput(&inputs, size_of::<INPUT>() as i32) != inputs.len() as u32 {
            return Err(Error::from_thread());
        }
        Ok(())
    }
}

pub struct Cursor {
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    pub hotspot: (u32, u32),
    pub shape: Option<Vec<u8>>,
}
pub fn cursor() -> Result<Cursor> {
    use windows::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    unsafe {
        if !interactive() {
            return Err(invalid());
        }
        let mut info = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        GetCursorInfo(&mut info)?;
        let mut result = Cursor {
            x: info.ptScreenPos.x,
            y: info.ptScreenPos.y,
            visible: info.flags == CURSOR_SHOWING,
            hotspot: (0, 0),
            shape: None,
        };
        if !result.visible {
            return Ok(result);
        }
        let icon = CopyIcon(HICON(info.hCursor.0))?;
        struct Icon(HICON);
        impl Drop for Icon {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyIcon(self.0);
                }
            }
        }
        let _icon = Icon(icon);
        let mut data = ICONINFO::default();
        GetIconInfo(icon, &mut data)?;
        struct Bitmap(HBITMAP);
        impl Drop for Bitmap {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteObject(HGDIOBJ(self.0.0));
                }
            }
        }
        let _mask = Bitmap(data.hbmMask);
        let _color = Bitmap(data.hbmColor);
        result.hotspot = (data.xHotspot, data.yHotspot);
        // Monochrome AND/XOR and animated cursor semantics need their own transport;
        // keep position-only rather than inventing a shape.
        if data.hbmColor.is_invalid() {
            return Ok(result);
        }
        let mut bitmap = BITMAP::default();
        if GetObjectW(
            HGDIOBJ(data.hbmColor.0),
            size_of::<BITMAP>() as i32,
            Some((&mut bitmap as *mut BITMAP).cast()),
        ) == 0
        {
            return Ok(result);
        }
        let (w, h) = (bitmap.bmWidth, bitmap.bmHeight);
        if w <= 0 || h <= 0 || w > 128 || h > 128 {
            return Ok(result);
        }
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err(invalid());
        }
        struct Dc(HDC);
        impl Drop for Dc {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteDC(self.0);
                }
            }
        }
        let _dc = Dc(dc);
        let header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = std::ptr::null_mut();
        let surface = CreateDIBSection(Some(dc), &header, DIB_RGB_COLORS, &mut pixels, None, 0)?;
        let _surface = Bitmap(surface);
        if pixels.is_null() {
            return Err(invalid());
        }
        let length = w as usize * h as usize * 4;
        std::ptr::write_bytes(pixels, 0, length);
        let old = SelectObject(dc, HGDIOBJ(surface.0));
        let rendered = DrawIconEx(dc, 0, 0, icon, w, h, 0, None, DI_NORMAL);
        SelectObject(dc, old);
        rendered?;
        let bgra = std::slice::from_raw_parts(pixels as *const u8, length);
        if bgra.chunks_exact(4).all(|p| p[3] == 0) {
            return Ok(result);
        }
        let mut rgba = Vec::with_capacity(length);
        for p in bgra.chunks_exact(4) {
            let alpha = p[3] as u32;
            let straight = |v: u8| {
                if alpha == 0 {
                    0
                } else {
                    ((v as u32 * 255 + alpha / 2) / alpha).min(255) as u8
                }
            };
            rgba.extend_from_slice(&[straight(p[2]), straight(p[1]), straight(p[0]), p[3]]);
        }
        result.shape = crate::desktop_pixels::cursor_png(w as usize, h as usize, &rgba);
        Ok(result)
    }
}

pub fn wheel_units_per_line() -> Result<(f64, f64)> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let (mut x, mut y) = (0u32, 0u32);
        SystemParametersInfoW(
            SPI_GETWHEELSCROLLCHARS,
            0,
            Some((&mut x as *mut u32).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )?;
        SystemParametersInfoW(
            SPI_GETWHEELSCROLLLINES,
            0,
            Some((&mut y as *mut u32).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )?;
        // Page scrolling has no line-equivalent. Never silently invent a conversion.
        if x == 0 || y == 0 || x == u32::MAX || y == u32::MAX {
            return Err(invalid());
        }
        Ok((120.0 / x as f64, 120.0 / y as f64))
    }
}
