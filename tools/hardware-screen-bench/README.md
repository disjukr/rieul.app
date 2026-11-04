# Hardware Screen comparison (no x264)

Standalone macOS synthetic benchmark. Uses VideoToolbox hardware-only H.264;
no capture, input, permissions, services or network. No voxl/x264 dependency.
Run `cargo run --release --manifest-path tools/hardware-screen-bench/Cargo.toml`.

Same allocated NV12 inputs, 60fps timestamps, 8Mbps AverageBitRate target,
Baseline 4.2, real-time encoding, no B-frame reordering. Compare forced all-IDR
with a forced IDR every four frames. Three interleaved repetitions per case,
12 warmup frames plus 120 measured frames. Measurements on Apple M1 Max.
Decode each output with VideoToolbox and compare reconstructed luma to the
original input. Decode/quality work is outside the encode wall/CPU interval.
PSNR is calculated from aggregate luma MSE, not averaged frame PSNR.

The benchmark adapter uses the same encoder settings but is not the live capture
pipeline. Results exclude capture, IPC, network, browser decode/render and
unchanged-frame suppression. The two modes have identical requested settings,
not equal achieved bitrate or visual quality. PSNR is one objective metric,
not a substitute for screen text legibility/visual assessment. `full-motion`
is deterministic high-entropy changing noise, not recorded desktop/video.

| Resolution / synthetic input | Mode | Encode median ms | Encode p95 ms | MiB / 120 frames | Luma PSNR dB |
|---|---|---:|---:|---:|---:|
| 1280×720 / scroll | vt-current-all-idr | 9.54 | 9.74 | 6.17 | 62.65 |
| 1280×720 / scroll | vt-closed-gop4 | 9.80 | 9.98 | 1.02 | 52.95 |
| 1280×720 / full-motion | vt-current-all-idr | 9.59 | 9.80 | 98.86 | 43.71 |
| 1280×720 / full-motion | vt-closed-gop4 | 9.80 | 9.98 | 6.11 | 13.28 |
| 1920×1080 / scroll | vt-current-all-idr | 6.68 | 6.83 | 13.18 | 46.42 |
| 1920×1080 / scroll | vt-closed-gop4 | 6.89 | 7.09 | 2.10 | 51.47 |
| 1920×1080 / full-motion | vt-current-all-idr | 6.78 | 7.00 | 205.61 | 41.72 |
| 1920×1080 / full-motion | vt-closed-gop4 | 6.90 | 7.07 | 13.74 | 13.28 |

GOP4 reduces bytes substantially on scrolling checkerboards. Luma PSNR is better
at 1080p but worse at 720p, with slightly greater encoder wall time in both. On high-entropy noise,
GOP4 has substantially worse quality. All-IDR itself greatly overshoots the
nominal bitrate target. Therefore byte savings are not uniformly an equal-quality
compression gain; there is no demonstrated encoder-latency improvement or
complete remote-session performance improvement. Do not silently market this
as equivalent-quality optimization. A matched-quality rate sweep and live
pipeline measurement are still needed before a general performance claim.

Raw three-repetition results are in `results/m1-max-2026-11-04.json`.
