# voxl code used by Screen

Upstream: https://github.com/tembo/voxl/tree/a24c7171bc3b678101a14b3b21521836a414bf7b

`daemon/host/src/desktop_flow.rs` is an adapted source port of
`src/video.rs::flow_ok` (lines 184–214 at that commit), under the accompanying
MIT license. The queue-window calculation, age threshold and stalled-client
resynchronization are upstream code adapted to Rieul's authenticated per-track
render receipts and bounded ledger. This is executable production-path code,
not merely a design reference. Rieul tests exercise its real transport path.

This is a partial integration, not embedding voxl's complete server or capture
pipeline. voxl's `run` owns process lifecycle, listeners and panic handling; it
is not called. voxl's x264 encoder, dependencies, bitrate controller, stripe
scheduler, macroblock hints and paintover are not included. No x264 binary or
GPL source is linked or packaged by this branch. The earlier x264 experiment
remains on a separate unpublished branch, outside this branch's ancestry.

The following are Rieul adaptations, not claimed as copied upstream code:

- The macOS VideoToolbox encoder now emits closed groups of at most four frames,
  with a forced IDR at each group boundary. An unexpected encoder keyframe ends
  the current group and triggers a cached-image IDR on the next group.
- ScreenCaptureKit dirty rectangles suppress unchanged samples; an explicit
  refresh can encode the latest retained image even without new damage.
- Bounded incremental helper IPC delivers encoded frames before the group ends.
- Browser receipts identify an actually rendered group/object; stale decoder
  callbacks neither render nor acknowledge. Legacy feedback without object IDs
  continues without the new receipt window.
- Failed streams and explicit keyframe requests refresh independently per track.
  Input, control epochs, authentication and update-drain ownership are retained.

Windows retains its existing hardware encoder and single-frame groups through
`Backend` defaults. It uses the common IPC/flow path but does not gain the new
macOS damage/short-GOP capture implementation. No Windows runtime optimization
or AV1 availability is claimed.

## Validation boundary

`export_synthetic_hardware_groups` feeds only allocated NV12 black pixels to the
same native hardware encoder/packet callback, verifies three four-frame groups,
and can regenerate `web/tests/fixtures/desktop-hardware-groups.json` with
`RIEUL_DESKTOP_SYNTHETIC_GROUPS_OUT`. The fixture was produced on Apple M1 Max.
No screen capture or OS input occurs.

`browser_hardware_ipc_two_displays_and_disconnect_release` replays those encoded
frames through the real incremental helper IPC and authenticated localhost
WebTransport to installed Chrome. It tests two independent track IDs, cancels
one unidirectional stream, requests a refresh, receives rendered-object ACKs,
and verifies held fake-key release and drain after disconnect. Both test tracks
use the same black fixture; this does not demonstrate distinct physical screens.
The hardware encoder runs when generating the fixture, not live in this replay.

On 2026-11-04, the cancellation run rendered 16/12 frames, sent 28 feedbacks,
and observed seven track/group pairs. First rendered frames occurred at about
206/301 ms after browser attachment setup began. These are one-run functional
observations, not an end-to-end latency benchmark or a performance improvement.
They exclude live capture and live encoding. The earlier equal-input benchmark
found materially fewer bytes for hardware GOP4 than all-IDR, but did not match
visual quality or measure complete remote-session latency. No performance
improvement claim is made here.

Real guest capture/dirty-rectangle behavior, hardware scene-change behavior,
Windows runtime, degraded real networks and equal-quality complete-pipeline
benchmarks remain unverified. No host permission, display, service, pairing or
trust settings were changed. This checkpoint needs focused review before main
integration/release.

Checkpoint checks: Rust core 47/47, host 187/187, macOS 122/122;
125 Node unit/codegen tests; TypeScript check and Vite build; 49 Chrome UI tests;
explicit synthetic hardware GOP test and the real localhost IPC/WebTransport
browser replay above. Hardware/VM and long-running opt-in tests otherwise remain
ignored by the aggregate command. Initial sandboxed transport tests failed to
bind localhost (EPERM); rerunning the same synthetic tests with permitted local
network access passed. No product failure was hidden by that retry.
