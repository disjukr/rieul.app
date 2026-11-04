// CPU-only allocated-pixel tracking benchmark; rustc --edition 2024 -O tools/spatial-paintover-bench.rs
#![allow(dead_code)]
#[path = "../daemon/host/src/desktop_paintover.rs"]
mod paintover;
fn main() {
    let mut p = paintover::SpatialPaintover::default();
    let mut y = vec![48; 1280 * 720];
    let uv = vec![128; 1280 * 360];
    let start = std::time::Instant::now();
    let mut selected = 0;
    for i in 0..600 {
        y[0] = (i % 255) as u8;
        p.observe(
            &y,
            1280,
            &uv,
            1280,
            1280,
            720,
            std::time::Duration::from_micros(i * 16667),
        )
        .unwrap();
        selected += u32::from(
            p.select(
                std::time::Duration::from_micros(i * 16667),
                &[(0, 368), (368, 352)],
            ) != 0,
        );
        p.painted();
    }
    println!(
        "720p spatial tracking: {} us/frame, {} refinement objects in 600 continuously moving frames",
        start.elapsed().as_micros() / 600,
        selected
    );
}
