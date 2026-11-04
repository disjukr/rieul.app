use std::{ffi::c_void, time::Instant};
unsafe extern "C" {
    fn bench_new(w: u32, h: u32, fps: u32, bitrate: u32) -> *mut c_void;
    fn bench_drop(p: *mut c_void);
    fn bench_mse(p: *mut c_void) -> f64;
    fn bench_encode(
        p: *mut c_void,
        y: *const u8,
        uv: *const u8,
        w: u32,
        h: u32,
        t: u64,
        key: bool,
    ) -> usize;
}
struct Hardware(*mut c_void);
impl Drop for Hardware {
    fn drop(&mut self) {
        unsafe { bench_drop(self.0) }
    }
}
fn cpu() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut t) },
        0
    );
    t.tv_sec as f64 + t.tv_nsec as f64 / 1e9
}
fn main() {
    let mut output = vec![];
    for (w, h) in [(1280u32, 720u32), (1920, 1080)] {
        for pattern in ["scroll", "full-motion"] {
            for repeat in 0..3 {
                for mode in ["vt-current-all-idr", "vt-closed-gop4"] {
                    let p = unsafe { bench_new(w, h, 60, 8_000_000) };
                    assert!(!p.is_null(), "hardware unavailable");
                    let hw = Hardware(p);
                    let mut mse = 0.;
                    let mut y = vec![0; (w * h) as usize];
                    let uv = vec![128; y.len() / 2];
                    let mut timings = vec![];
                    let mut bytes = 0usize;
                    let mut cpu_seconds = 0.;
                    for n in 0..132u64 {
                        // Deterministic neutral-chroma synthetic frames. Same bytes for each mode.
                        for row in 0..h as usize {
                            for x in 0..w as usize {
                                let sx = x + (n as usize) * 7;
                                let sy = row + (n as usize) * 3;
                                y[row * w as usize + x] = if pattern == "scroll" {
                                    if (sx / 24 + sy / 18) % 2 == 0 {
                                        48
                                    } else {
                                        208
                                    }
                                } else {
                                    16 + ((sx.wrapping_mul(1103515245)
                                        ^ sy.wrapping_mul(12345)
                                        ^ n as usize * 99991)
                                        % 220) as u8
                                };
                            }
                        }
                        let key = mode == "vt-current-all-idr" || n % 4 == 0;
                        let time = (n + 1) * 1_000_000 / 60;
                        let c = cpu();
                        let start = Instant::now();
                        let size =
                            unsafe { bench_encode(hw.0, y.as_ptr(), uv.as_ptr(), w, h, time, key) };
                        let elapsed = start.elapsed().as_secs_f64() * 1000.;
                        let used = cpu() - c;
                        assert!(size > 0, "encode failed {mode} {n}");
                        let distortion = unsafe { bench_mse(hw.0) };
                        assert!(distortion >= 0.);
                        if n >= 12 {
                            mse += distortion;
                            timings.push(elapsed);
                            cpu_seconds += used;
                            bytes += size;
                        }
                    }
                    timings.sort_by(f64::total_cmp);
                    let wall: f64 = timings.iter().sum();
                    let row = serde_json::json!({"width":w,"height":h,"pattern":pattern,"mode":mode,"repeat":repeat,"frames":120,"luma_psnr_db":10.*(255f64*255./(mse/120.).max(1e-12)).log10(),"median_ms":timings[60],"p95_ms":timings[113],"total_encode_ms":wall,"process_cpu_ms":cpu_seconds*1000.,"bytes":bytes});
                    eprintln!("{row}");
                    output.push(row);
                }
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
