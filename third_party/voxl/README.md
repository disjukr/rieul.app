# voxl code used by Screen

Upstream: https://github.com/tembo/voxl/tree/a24c7171bc3b678101a14b3b21521836a414bf7b

`daemon/host/src/desktop_flow.rs` is an adapted source port of
`src/video.rs::flow_ok` (lines 184–214 at that commit);
`daemon/host/src/desktop_rate.rs` ports `RateCtl` (lines 219–348), under the accompanying
MIT license. The queue-window calculation, age threshold and stalled-client
resynchronization are upstream code adapted to Rieul's authenticated per-track
render receipts and bounded ledger. This is executable production-path code,
not merely a design reference. Rieul tests exercise its real transport path.

This is a partial integration, not embedding voxl's complete server or capture
pipeline. voxl's `run` owns process lifecycle, listeners and panic handling; it
is not called. voxl's x264 encoder, dependencies, stripe
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
trust settings were changed. Independent review and the follow-up tests below precede main integration;
a signed release and installed-daemon update are separate actions.

Checkpoint checks: Rust core 47/47, host 187/187, macOS 122/122;
125 Node unit/codegen tests; TypeScript check and Vite build; 49 Chrome UI tests;
explicit synthetic hardware GOP test and the real localhost IPC/WebTransport
browser replay above. Hardware/VM and long-running opt-in tests otherwise remain
ignored by the aggregate command. Initial sandboxed transport tests failed to
bind localhost (EPERM); rerunning the same synthetic tests with permitted local
network access passed. No product failure was hidden by that retry.

## Follow-up review and platform work

Independent source/security review found a P2: completed incremental IPC queue
overflow (`Busy`) was treated as fatal by the transport. The follow-up preserves
only terminal Busy as retryable, waits for producer completion, requests a fresh
GOP and keeps attachment/control. The real overflow unit test plus browser
injections before any frame and after the first frame cover both recovery paths.
The reviewer confirmed the blocker resolved and found no new blocker.

Windows now caches the last validated independent encoded packet per track/codec
(max 4 MiB, at most 32 tracks) for explicit idle refresh, and skips DXGI pointer-only
updates after receiving its first image. It still uses single-frame hardware
GOPs; no Windows short-GOP/dedicated capture-worker optimization is claimed.
The real modified Windows adapter/native API types were checked for x64 using a
local harness with stubbed host traits; this does not link a Windows executable.
Six pure image/key tests pass. No Windows guest hardware test was run.
DXGI's update semantics are documented at:
https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info

A new MIT/Apache-only standalone benchmark in `tools/hardware-screen-bench`
compares the same hardware/settings and synthetic inputs, including decoded luma
PSNR. Scroll patterns use fewer bytes with mixed PSNR results; high-entropy noise loses substantial
quality; encoding is not faster. See its README and raw data for the actual
numbers and limits. These findings prohibit an unqualified performance claim.


## Default pipeline transition

The user accepted the known quality tradeoff and requested replacement of the
old structure. The default macOS capture path now uses short hardware GOPs;
there is no experimental enable switch. The private batched `Group` command
(tag 5) and result (tag 4) are retired, never reused. All live helper media uses
incremental bounded `StreamGroup`/`GroupFrame`/terminal completion. Private IPC
requires the same installed helper/daemon code; public rendered-object receipts
remain additive and older viewers retain existing feedback without ACK gating.

The additional upstream `RateCtl` source port controls automatic-mode transport
pacing using exact rendered-object byte receipts, minimum observed delivery
latency (not raw RTT), age and a 250ms byte window. It never changes manual targets
or exceeds the configured track budget. Samples expire after one second; idle
screens do not justify increasing estimated capacity. It does not directly
reconfigure the native encoder bitrate. The existing quality negotiation/target
limits remain; actual visual quality, fps and bandwidth are not guaranteed.

This replaces Rieul's batch/all-IDR media transport with a voxl-derived flow/rate
pipeline. It is not the complete upstream executable: its listener, runtime,
signal hooks, capture, input, stripe/paintover and x264-specific machinery are not
embedded. Rieul's authentication, session ownership and hardware backends remain.
The MIT attribution is included in root LICENSE-MIT, which packaging already
copies to distributable licenses. No GPL dependency is introduced.

Final review found no new auth, lock-order or drain blocker. New regressions cover
unknown/duplicate ACK bytes, stale samples/new epochs, and manual target bypass.


## Native worker follow-up

Windows capture/encoding no longer shares its input/console worker. Each track
owns a bounded video worker with COM/DXGI/MF creation and destruction on that
thread; cancellation drains to producer completion, preserving update protection.
This is Rieul's hardware adaptation of the upstream bounded video worker design,
not a copied x264 worker. Upstream MIT `win/capture.rs::frame_rects` and the GPU
copy scheduling from `copy_rects` are now actually ported: persistent staging,
clipped dirty/move destinations, partial CopySubresourceRegion for at most 32
regions and whole-image fallback otherwise. Added metadata/length checks cap
allocation and fall back to full copying on missing evidence. CPU readback is
still a full bounded BGRA image before NV12 conversion, not upstream's partial
CPU image update.

Hardware H.264 delta frames are probed with synthetic pixels per track before
selecting short groups. A successful actual non-key output enables up to four
frames, bounded by fps and group time; otherwise independent-frame operation is
retained. AV1 remains independent-frame only. Cached refresh re-encodes the latest
pixels as an independent frame, rather than replaying an outdated group keyframe.
The probe encoder is discarded before live encoding. No software encoder is used.

Review found and resolved low-fps group timeout and dead-worker-as-Busy bugs;
regressions cover 1fps, initialization failure, producer panic, cancellation,
independent workers and owner-thread destruction. Seven portable pixel/rectangle
tests and the x64 Windows API type harness passed. Actual GPU initialization,
dirty/move readback and delta output still require Windows runtime evidence.

Remaining upstream differences are intentional or unimplemented, not advertised
as completed: macOS upstream converts ScreenCaptureKit NV12 to CPU I420 for x264;
Rieul retains direct NV12-to-VideoToolbox. Macroblock analysis hints, CRF/VBV
paintover, encoder thread governors and striped x264 instances require hardware
API equivalents and platform validation. The current RateCtl still controls
transport pacing, not native encoder reconfiguration. Whole-session live capture
latency and equal-quality performance remain unproven.

## Native encoder rate targets (after 0.6.23)

The authenticated private StreamGroup request carries a required encoder bitrate
separately from the unchanged negotiated track descriptor. Both proxy and helper
reject zero, above-track-budget and non-u32 targets. Automatic mode supplies the
voxl RateCtl target based on current rendered-object receipts; manual mode uses
the negotiated target. This fine-grained control is distinct from the existing
coarse resolution/fps quality ladder and does not replace tracks, windows or
control epochs.

At a completed GOP boundary, macOS updates VideoToolbox AverageBitRate under the
capture lock. Windows applies MeanBitRate on the encoder's COM thread only when
its current rate-control mode is a known CBR/VBR mode and IsModifiable returns
exact S_OK. SetValue must also return exact S_OK (S_FALSE means read-only),
and GetValue must confirm the requested target. Quality mode, unknown support or setter rejection retain encoding
and transport pacing; rejected native setters are not retried every group.
These properties are soft targets, not output bitrate or quality guarantees.

Synthetic M1 Max validation changed and read back 2 Mbps → 0.5 Mbps → 2 Mbps on
one hardware VideoToolbox session and encoded twelve frames across the changes.
The private IPC regression verifies target changes, unchanged track/codec epoch,
held input preservation, and invalid-budget rejection. Worker tests verify exact
rate/refresh handoff. Host 198 and macOS 122 aggregate tests, the Windows x64 API
type harness and the isolated two-track IPC/WebTransport/Chrome replay pass.
The replay uses preencoded frames, so it does not measure live dynamic encoding.
Windows real hardware rate reconfiguration remains unverified.

Desktop 0.6.23 is pinned to 30bce96 and excludes this follow-up. Remaining work
includes stripe/paintover equivalents, browser decode/render workers, Windows
partial CPU readback/conversion and access-loss recovery, and validation of
upstream color-space differences. No x264/GPL encoder is introduced.

## Bounded continuous groups and settled-image scheduling

The next checkpoint ports `encode_loop`'s `last_motion` / `paintover_left`
state machine into `desktop_paintover.rs`. Hardware H.264 producers keep references
for up to 60 frames or one second instead of forcing IDR every four frames.
After 200ms without new damage, they submit the retained image at most four more
times. New damage restarts the budget; output failure does not consume it.
macOS polls its existing latest-only slot in bounded intervals. Windows uses the
same policy only after its existing actual delta-output probe succeeds; other
encoders retain independent-frame behavior. No extra capture instance is created.

This is bounded refinement scheduling, **not completed high-quality paintover**.
It keeps the same encoder rate target. x264 CRF/macroblock hints are not emulated.
A hardware quality-mode alternative still needs explicit support probing and
bounded rate-control design: Apple's BaseFrameQP disables ordinary bitrate
control and must be supplied on every frame in that session. It cannot safely
be enabled only for a few refinement frames in the existing bitrate session.

The optional VideoToolbox MaxKeyFrameInterval=60 setting avoids the observed
30-frame default on the test machine; it does not prohibit spontaneous IDRs.
Those still terminate the current dependency chain and request a fresh keyframe.
The server checks the actual receipt window before each subsequent object, waits
at most 250ms, and rechecks attachment validity before sending after a wait.
Existing bounded IPC, producer completion and drain ownership remain in force.

The allocated-pixel VideoToolbox test encoded three 60-frame groups and changed
rate targets between them. The localhost helper IPC/WebTransport/Chrome test can
consume that fixture via RIEUL_DESKTOP_GROUP_FIXTURE. Its long-GOP variant holds
receipts for 500ms, requests refresh mid-group, cancels a stream, checks rendered
object IDs beyond ten in one group and later-group recovery, then verifies held
fake-input release and drain. These are separate hardware generation and browser
replay stages, not live capture-to-browser latency evidence.

`tools/hardware-screen-bench/examples/paintover.rs` compares identical allocated
720p inputs/settings at an 8Mbps target. GOP60 preserved scroll luma PSNR near
79.42dB during four settled repeats; GOP4's first new IDR fell to 36.51dB then
reached 55.24dB. On high-entropy noise, GOP60 improved only 13.05 → 13.12dB,
while GOP4 reached 14.15dB. Encoding was approximately 9.5–10.1ms. One run,
two synthetic patterns, unmatched achieved quality: no general quality or
end-to-end latency improvement is claimed. Raw results are checked in.

Stripe configuration, independent-stripe encoding/composition, dirty-region
selection and selective stripe resynchronization are not part of this checkpoint.
Neither are completed high-quality paintover, live guest/GPU validation on
Windows, or matched-quality full-session latency measurements. No public RPC
support claim, driver installation or host display/permission change is added.

## Negotiated macOS stripes (next checkpoint)

Profile 2 uses voxl's aligned horizontal stripe layout with two independent
hardware H.264 sessions sharing one retained capture image. The native producer
compares copied NV12 rows against each stripe's retained image and encodes only
changed stripes; initial/recovery keyframes and settled repeats include both.
Independent stripe encodes run concurrently, with one aggregate bitrate budget.
This is an adaptation of the MIT pipeline, not upstream `run()` or x264 linkage.

The optional `supportedProfiles` capability is an explicit list. Profile 1
remains the legacy full-frame format. Profile 2 carries a bounded bundle of
indexed Annex-B packets; first objects require every stripe's independent IDR.
The browser uses separate decoders and atomically composites a complete object,
retaining unchanged regions. It acknowledges every rendered object independently
of throttled UI statistics. Recovery currently resets the whole group, not just
one damaged stripe. Bounds include two stripes, 3840x2160 per track, 4 MiB per
bundle and 32 Mi output pixels per attachment. Encoder allocation/probe failure
is reported; the browser releases input and retries profile 1 once without
restoring control. Permission/authentication errors do not trigger that retry.

Allocated-pixel hardware export produced 60 objects: two key packets initially,
then alternating single-stripe changes. Localhost signed-helper fixture IPC,
WebTransport and Chrome replay verified contrasting top/bottom pixels, two
viewports, delayed receipts, refresh, stream cancellation and fake held-input
cleanup. Generation and replay are separate stages: no live host capture, no
matched-quality end-to-end latency claim. Actual multi-display GPU capacity is
not established by this fixture. Native support queries probe the requested
stripe sessions together; success is not a sustained-throughput guarantee.

Windows retains profile 1 and does not advertise stripe support. High-quality
paintover remains incomplete: bounded same-rate settled repeats are present,
but the quality experiments above do not establish a matched-quality gain.
No x264/GPL binary, driver or host display/permission change is included.
