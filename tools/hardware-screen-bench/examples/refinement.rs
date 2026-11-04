//! Allocated pixels only: base 8Mbps, settled target 8/16/32Mbps.
//! Raw encoder experiment; production additionally enforces negotiated ceiling
//! and actual-byte refinement credit. This is not an end-to-end latency test.
//! Equal settings/input, not a claim of equal achieved quality or live latency.
use std::{ffi::c_void, time::Instant};
unsafe extern "C" {
    fn bench_new(w: u32, h: u32, fps: u32, bitrate: u32) -> *mut c_void;
    fn bench_drop(p: *mut c_void);
    fn bench_rate(p: *mut c_void, rate:u32)->bool;
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
fn main() {
    let mut rows = vec![];
    for pattern in ["scroll", "noise"] {
        for boost in [1, 2, 4] {
        let gop=60;
            let (w, h) = (1280, 720);
            let hw = Hardware(unsafe { bench_new(w, h, 60, 8_000_000) });
            assert!(!hw.0.is_null(), "hardware encoder unavailable");
            let mut y = vec![0; (w * h) as usize];
            let uv = vec![128; y.len() / 2];
            for frame in 0..48u64 {
                // Motion through frame31, then four repeats after a 200ms idle.
                if (32..44).contains(&frame) {
                    continue;
                }
                let n = frame.min(31) as usize;
                for row in 0..h as usize {
                    for x in 0..w as usize {
                        let (sx, sy) = (x + n * 7, row + n * 3);
                        y[row * w as usize + x] = if pattern == "scroll" {
                            if (sx / 24 + sy / 18) % 2 == 0 {
                                48
                            } else {
                                208
                            }
                        } else {
                            16 + ((sx.wrapping_mul(1103515245)
                                ^ sy.wrapping_mul(12345)
                                ^ n * 99991)
                                % 220) as u8
                        };
                    }
                }
                if frame == 44 { assert!(unsafe {bench_rate(hw.0, 8_000_000 * boost)}); }
                let start = Instant::now();
                let bytes = unsafe {
                    bench_encode(
                        hw.0,
                        y.as_ptr(),
                        uv.as_ptr(),
                        w,
                        h,
                        frame * 1_000_000 / 60,
                        frame % gop == 0,
                    )
                };
                let micros = start.elapsed().as_micros();
                assert!(bytes > 0, "frame {frame}, GOP {gop} rejected");
                let mse = unsafe { bench_mse(hw.0) };
                assert!(mse >= 0. && mse.is_finite());
                if frame >= 31 {
                    rows.push(serde_json::json!({"pattern":pattern,"gop":gop,"boost":boost,"frame":frame,"bytes":bytes,"encode_micros":micros,"luma_psnr_db":10.*(255f64*255./mse.max(1e-12)).log10()}));
                }
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&rows).unwrap());
}
