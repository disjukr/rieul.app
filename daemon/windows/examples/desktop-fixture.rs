//! Explicit, interactive VM diagnostic. Never executed automatically by CI.
//! --probe uses synthetic pixels only; --exercise creates its own input target.
#[cfg(windows)]
mod fixture {
    use rieul_windows_daemon::desktop_native as native;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows::{
        Win32::{
            Foundation::*, Graphics::Gdi::*, System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::*,
        },
        core::w,
    };
    static KEYS_DOWN: AtomicUsize = AtomicUsize::new(0);
    static KEYS_UP: AtomicUsize = AtomicUsize::new(0);
    static BUTTONS: AtomicUsize = AtomicUsize::new(0);
    static WHEELS: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe {
            match message {
                WM_KEYDOWN => {
                    KEYS_DOWN.fetch_add(1, Ordering::SeqCst);
                }
                WM_KEYUP => {
                    KEYS_UP.fetch_add(1, Ordering::SeqCst);
                }
                WM_LBUTTONDOWN | WM_LBUTTONUP => {
                    BUTTONS.fetch_add(1, Ordering::SeqCst);
                }
                WM_MOUSEWHEEL => {
                    WHEELS.fetch_add(1, Ordering::SeqCst);
                }
                WM_PAINT => {
                    let mut ps = PAINTSTRUCT::default();
                    let dc = BeginPaint(hwnd, &mut ps);
                    let mut rect = RECT::default();
                    let _ = GetClientRect(hwnd, &mut rect);
                    let brush = CreateSolidBrush(COLORREF(0x000000ff));
                    FillRect(dc, &rect, brush);
                    let _ = DeleteObject(brush.into());
                    let _ = EndPaint(hwnd, &ps);
                    return LRESULT(0);
                }
                _ => (),
            }
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
    }
    fn pump() {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    fn focus(hwnd: HWND) -> anyhow::Result<()> {
        anyhow::ensure!(
            unsafe { GetForegroundWindow() } == hwnd,
            "fixture lost foreground; refusing input"
        );
        Ok(())
    }
    struct Window(HWND);
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    pub fn run() -> anyhow::Result<()> {
        let exercise = match std::env::args().nth(1).as_deref() {
            Some("--probe") => false,
            Some("--exercise") => true,
            _ => anyhow::bail!(
                "Use --probe (synthetic encoder only) or --exercise (VM capture and input to a newly created fixture window)."
            ),
        };
        let _apartment = native::Apartment::enter()?;
        println!(
            "architecture={} interactive={}",
            std::env::consts::ARCH,
            native::interactive()
        );
        let mut pixels = vec![16u8; 640 * 480 * 3 / 2];
        pixels[640 * 480..].fill(128);
        for (name, codec) in [("h264", native::Codec::H264), ("hevc", native::Codec::Hevc), ("av1", native::Codec::Av1)] {
            match native::HardwareEncoder::with_codec(640, 480, 30, 2_000_000, codec).and_then(
                |e| {
                    let packet = e.encode_keyframe(&pixels, 0)?;
                    if codec != native::Codec::Av1 {
                        println!("hardware_{name}_dynamic_bitrate={}", e.set_bitrate(1_000_000));
                        match e.encode(&pixels, 33_333, false) {
                            Ok((delta, key)) => {
                                println!("hardware_{name}_delta={} bytes={}", !key, delta.len())
                            }
                            Err(error) => println!("hardware_{name}_delta=unavailable error={error}"),
                        }
                    }
                    Ok(packet)
                },
            ) {
                Ok(packet) => println!("hardware_{name}=available bytes={}", packet.len()),
                Err(e) => println!("hardware_{name}=unavailable error={e}"),
            }
        }
        if !exercise {
            return Ok(());
        }
        anyhow::ensure!(native::interactive(), "interactive VM desktop required");
        let instance = unsafe { GetModuleHandleW(None)? };
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance.into(),
            lpszClassName: w!("RieulDesktopIsolatedFixture"),
            ..Default::default()
        };
        anyhow::ensure!(
            unsafe { RegisterClassW(&class) } != 0,
            "register fixture window"
        );
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class.lpszClassName,
                w!("Rieul Desktop Fixture"),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                640,
                480,
                None,
                None,
                Some(instance.into()),
                None,
            )?
        };
        let _window = Window(hwnd);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
            let _ = UpdateWindow(hwnd);
        }
        pump();
        focus(hwnd)?;
        let mut point = POINT { x: 100, y: 100 };
        anyhow::ensure!(
            unsafe { ClientToScreen(hwnd, &mut point) }.as_bool(),
            "fixture coordinates"
        );
        for _ in 0..10 {
            pump();
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let mut captured = false;
        for display in native::displays()? {
            let Some((a, o)) = display.id.split_once('.') else {
                continue;
            };
            match native::Duplication::open(a.parse()?, o.parse()?) {
                Ok(capture) => {
                    for _ in 0..20 {
                        pump();
                        if let Some(frame) = capture.next()? {
                            let x = point.x - capture.bounds.left;
                            let y = point.y - capture.bounds.top;
                            if x >= 0
                                && y >= 0
                                && (x as u32) < frame.width
                                && (y as u32) < frame.height
                            {
                                let n = y as usize * frame.stride + x as usize * 4;
                                let pixel = &frame.bytes[n..n + 4];
                                println!(
                                    "capture={}x{} fixture_bgra={pixel:?}",
                                    frame.width, frame.height
                                );
                                anyhow::ensure!(
                                    pixel[2] > 240 && pixel[1] < 16 && pixel[0] < 16,
                                    "fixture red pixel mismatch"
                                );
                                captured = true;
                                break;
                            }
                        }
                    }
                }
                Err(e) => println!("capture_unavailable={e}"),
            }
        }
        focus(hwnd)?;
        native::key(0x1e, false, true)?;
        pump();
        // Release is unconditional after an injected down, including focus loss.
        native::key(0x1e, false, false)?;
        pump();
        focus(hwnd)?;
        native::mouse(point.x, point.y, Some((1, true)))?;
        pump();
        native::mouse(point.x, point.y, Some((1, false)))?;
        pump();
        focus(hwnd)?;
        native::wheel(0, 120)?;
        for _ in 0..10 {
            pump();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let counts = [
            KEYS_DOWN.load(Ordering::SeqCst),
            KEYS_UP.load(Ordering::SeqCst),
            BUTTONS.load(Ordering::SeqCst),
            WHEELS.load(Ordering::SeqCst),
        ];
        println!("input_counts={counts:?} capture_verified={captured}");
        anyhow::ensure!(
            counts[0] >= 1 && counts[1] >= 1 && counts[2] >= 2 && counts[3] >= 1,
            "fixture did not receive injected input"
        );
        Ok(())
    }
}
#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    fixture::run()
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows VM fixture only");
}
