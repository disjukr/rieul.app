# Localhost Screen replay observations

This measures the existing synthetic fixture, not a live Screen session. It replays
prerecorded VideoToolbox H.264 through helper IPC and authenticated localhost
WebTransport into the production browser receiver and worker. Both tracks are
640×480 at a requested 60 fps. Chrome was 157.0.8103.52. Decoder hardware identity
was not attested. The host uses a debug test build, not a tuned release build.

Reproduce from the repository root with installed pinned dependencies:

```sh
RIEUL_SCREEN_MEASURE_FRAMES=60 \
RIEUL_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
cargo test -p rieul-daemon-host \
  browser_hardware_ipc_two_displays_and_disconnect_release -- --ignored --nocapture
```

The optional frame goal accepts 16–120 and cannot lower the normal fixture goal.
Without it, the original stream path is retained. Measurement mode adds a
main-thread byte-counting TransformStream, which changes scheduling/backpressure.
Compare only runs using the same observation mode. No untapped timing comparison
was made. The third media stream is deliberately canceled by this fixture.

Three observation runs passed the existing pixel, independent-track, refresh,
stream-cancellation, authentication and held-key disconnect assertions. A separate
untapped default smoke run passed too. The first five rendered feedback samples per
track are excluded from timing quantiles. The reported byte totals and observation
durations include startup, warmup and recovery. The 150 ms final drain can produce
extra frames beyond the minimum goal. Runs had 113–140 post-warmup timing samples.

| Diagnostic                             | Three-run range |
| -------------------------------------- | --------------: |
| Decoder-admission-to-output p95        |   93.1–102.2 ms |
| Render callback p95                    |      5.9–6.6 ms |
| Browser-tapped media application bytes | 104,746–132,646 |
| Full observation duration              |     4.04–5.20 s |

Decode timing includes browser decoder scheduling. Render timing includes the
fixture's new canvas, draw and two pixel readbacks, plus worker-side callback work.
It does not include worker-message queue delay or physical monitor scanout. These
are diagnostic stage observations, not interaction or capture-to-render latency.
Browser-tapped application bytes are not wire bytes and may include queued chunks
later abandoned. They exclude the deliberately canceled stream, RPC, input,
feedback and all QUIC/TLS/UDP/IP overhead. Recovery changes the amount of media
observed, so totals are not a fixed-workload bandwidth comparison.

No improvement is demonstrated. The bottleneck was not profiled, the fixture is
small and prerecorded, and the debug host is not a production benchmark. Do not
choose an encoder, transport or pacing change from these observations. There is
no before/after claim. Actual capture, contemporaneous encoding and synthetic
cursor, typing, scroll and window-drag interaction latency remain unmeasured.
A dedicated authorized capture desktop is still required. No personal desktop,
OS input, security settings, package/release, or reference software was used.

Raw observations are in
[screen-localhost-replay-macos-2026-11-14.json](results/screen-localhost-replay-macos-2026-11-14.json).
