//! Native user-session primitives. Constructors perform capture only when called
//! explicitly by the desktop helper; no service startup path constructs these.
use std::{
    mem::{size_of, ManuallyDrop},
    time::{Duration, Instant},
};
use windows::{
    core::{Error, Interface, Result, HRESULT},
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
};
fn invalid() -> Error {
    Error::from_hresult(HRESULT(0x80070057u32 as i32))
}
/// Keep this guard and all native objects on their owning worker thread.
pub struct Apartment(std::marker::PhantomData<std::rc::Rc<()>>);
impl Apartment {
    pub fn enter() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(e);
            }
        }
        Ok(Self(std::marker::PhantomData))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
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
pub struct HardwareEncoder {
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    width: u32,
    height: u32,
    fps: u32,
}
impl HardwareEncoder {
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self> {
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
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
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
                    let output = media_type(MFVideoFormat_H264, width, height, fps)?;
                    output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                    output.SetUINT32(&MF_MT_MPEG2_PROFILE, 66)?;
                    output.SetUINT32(&MF_MT_MPEG2_LEVEL, 42)?;
                    transform.SetOutputType(0, &output, 0)?;
                    transform.SetInputType(
                        0,
                        &media_type(MFVideoFormat_NV12, width, height, fps)?,
                        0,
                    )?;
                    let codec: ICodecAPI = transform.cast()?;
                    codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
                    codec.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0u32))?;
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                    let events = transform.cast()?;
                    Ok(Self {
                        transform,
                        events,
                        width,
                        height,
                        fps,
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
                    kind if kind == METransformNeedInput.0 as u32 && !sent => {
                        let codec: ICodecAPI = self.transform.cast()?;
                        codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(true))?;
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
                        sent = true;
                    }
                    kind if kind == METransformHaveOutput.0 as u32 => {
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
                        // Never falsely advertise an arbitrary avcC/length-prefixed payload.
                        if !bytes.starts_with(&[0, 0, 0, 1]) && !bytes.starts_with(&[0, 0, 1]) {
                            return Err(invalid());
                        }
                        return Ok(bytes);
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
