# Hosted live Screen scroll fixture

This unproven test harness is restricted to the temporary
`screen-hosted-live-scroll-test` branch. The existing manual workflow can select
`scenario=scroll` at that exact ref for one functional run. It is not approved for
main. The default `capability` scenario remains restricted to main and unchanged. Both
scenarios refuse capture outside the expected disposable GitHub-hosted arm64
macOS runner, repository, branch and manual workflow identity. Missing existing
capture permission, active console or hardware support is a structured skip.
No permission request or settings change is attempted.

The scroll scenario starts a fullscreen synthetic AppKit scene and captures only
its fixed 640×480 physical-pixel region. One authenticated browser wheel event at
a time is routed to that scene's private control pipe, never to OS input APIs.
The scene scrolls its text and changes a monotonic visual marker. The marker has
a fixed signature, ID and complementary ID byte. This is a visual integrity check,
not a cryptographic signature. The native callback checks the fixture background
and marker before allowing the production native encoder to see the frame.

Actual production ScreenCaptureKit capture and hardware VideoToolbox encoding
feed encoded packets through a private pipe into the host test backend. Production
helper IPC codecs, Proxy/serve and authenticated localhost WebTransport then feed
the production browser video receiver. The attached canvas verifies the visual
marker, draws the frame and waits across two animation callbacks. Only the correct
completed visual action advances the next action. No pixels or encoded media are
logged, saved to a file or uploaded. Only bounded scalar metadata and timings are
printed. Native output is required to be a private pipe, never a terminal/file.

This is not the installed macOS helper connector. Its peer-code authentication,
root-owned bundle/socket path, privilege boundary and OS IPC overhead are not
measured. The existing in-memory helper IPC test channel is retained. The native
fixture forces fixed-rate full-frame dirty submissions, so production Rust
damage/paintover, adaptive encoder-rate handoff, unchanged suppression and cursor-plane behavior are not exercised. Encoder code
and settings remain the production native implementation. The single display
uses the existing attachment defaults of 60 fps and 20 Mbps, not an OS display
configuration change. HEVC is selected only when both encoder and browser support
it; the existing H.264 fallback remains available.

## Measurement contract

Before any tuning, prove correctness with one fresh producer and browser session
in a disposable runner VM. This is a functional prerequisite, not a production
performance baseline. It requires the initial marker, then five excluded warm-up
actions and 40 observed actions.
Cold first-frame time is separate. System load, CPU count, OS, browser and tool
versions are printed. The Rust host uses a release test build. Dependencies come
from the existing project lockfiles; the runner's installed Chrome is used.

- `actionToCanvasRafMs` uses one browser's `performance.now()` from before sending
  the wheel event until the two-callback completion. It includes input, app,
  capture, encoder, transport, decoder, marker readback and browser scheduling.
  It is not physical scanout or one-way capture latency.
- Native `CLOCK_UPTIME_RAW` measures received-to-applied, applied-to-marker-read
  and marker-read-to-packet-callback intervals. Marker-read includes capture
  availability and validation. The last interval includes native encoder/policy
  work, not only hardware execution. Native timing rows are correlated to the
  browser's recorded frame timestamp and visual ID. No browser/native clocks are
  subtracted or assumed synchronized.
- Decoder/render statistics are separate browser diagnostics. They can include
  repeated marker frames and are not the 40 action samples. Canvas scanline
  readback and the opt-in application-stream byte tap affect this fixture's cost.
- `encodedPayloadBytes` counts encoded bytes received from the producer, including
  packets not ultimately presented. `browserTappedMediaBytes` counts media
  application-stream chunks, including possible later-abandoned chunks. Neither
  is QUIC/TLS/UDP/IP wire bytes. Control/feedback and wire bytes are unmeasured.
- Each run reports sample counts, per-action samples, nearest-rank p50/p95,
  repeated/stale/invalid/future marker counts, queue/keyframe requests, send errors,
  timeouts and confirmed native shutdown. Repeated/stale markers are not inferred
  dropped-frame counts. Encoded packet counts are not unique frames or source FPS.

A passing fixture establishes this bounded path and its observations, not a
production speedup, quality match, rate ceiling, hardware decoder identity or
Voxl/Airhand comparison. A baseline limiter has not been profiled. Any proposed
optimization needs a separate profile, matching before/after conditions and at
least five alternating runs per arm. An effect smaller than run-to-run spread
is inconclusive. Never call a skip or failed visual check a performance pass.
