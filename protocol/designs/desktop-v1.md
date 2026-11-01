# Desktop v1 host/transport checkpoint (native backend not enabled)

This change defines IDs 66–72 and generated Rust/TypeScript codecs. The daemon
registers the control/input RPCs, but its default runtime has no native backend:
capabilities explicitly report Unsupported and attach cannot start. A test-only
backend exercises the same host path over certificate-verified localhost QUIC.
No real desktop is captured and no OS input is sent.

## Contract

`GetDesktopCapabilities`, `AttachDesktop` (server events),
`ConfigureDesktopViewports`, `SetDesktopControl`, `RenewDesktopLease`, and
`DetachDesktop` use ordinary RPC. `WriteDesktopInput` describes ordered streaming
input. The host processes each frame before EOF and returns the final sequence
receipt on clean half-close. Concurrent input streams for one attachment are
rejected; reset, malformed data and a five-second idle timeout release control.
Clean half-close preserves control for ordered stream rollover.

Attach explicitly negotiates profile 1, uni-stream media, browser-supported codecs
and a physical/text keyboard mode. Pairing grants access, while live credential
expiry/revocation and OS screen/input permission checks remain mandatory. No
per-session local approval or separate input/view grant exists.

One connection-bound attachment holds control. Viewing never takes it. Explicit
takeover releases all held state before advancing the epoch. Expiry, revocation,
detach and connection loss release control. A release failure fails closed and
retains the workload guard. Reconnect creates a fresh attachment and does not
restore control. The shared runtime serializes state changes. A session timer revalidates live
credentials/leases independently of blocked event writes; credential access is
serialized with store mutations. Connection and attach-stream cleanup remove
attachments and release input. Capture tasks retain independent work guards,
including non-cancelable blocking backend calls, until they actually exit.

Physical mode uses HID keyboard-page usages (left/right modifiers and keypad stay
distinct); text mode accepts text commits and modifier keys, not physical character
keys. Native adapters must reject unmapped usages. Composition/relative pointer are
currently unsupported by the state machine. Text commits are rejected while keys
are held. An OS adapter must ignore coordinates on button-up and release-all, so
stale geometry cannot prevent releasing input. No pointer coalescing is performed.

Multiple viewports each carry display/crop/output size/FPS/bitrate. Configuration
checks totals, duplicates, count and finite pointer bounds. The capture adapter must
also validate each display and crop against its current layout before applying a
configuration. A layout change invalidates viewports. Virtual display creation is
out of scope. Browser monitor enumeration and window placement remain optional;
manually moving viewer windows must remain possible.

## Media and bounds

A negotiated server uni stream contains one closed GOP: keyframe object 0 and
strictly ordered delta objects, with no preceding group references. Objects carry
attach/track/layout/codec/group identities. Each CBOR object has a big-endian u32
length prefix. Limits: 4 MiB/object, 16 MiB/group, 240 objects/group. A partial EOF,
wrong epoch, missing keyframe or discontinuity abandons the entire group. The
browser decoder budget defaults to three queued frames; exceeding it cancels the
current group and resets the WebCodecs decoder. It reports local recovery status
and resumes at the next independent group. Negotiated feedback carries bounded
decode/render times, queue depth and keyframe requests over the input channel;
viewers may send feedback without acquiring control.
The host limits each track to one producer/send operation, times out blocked media
streams, and paces bytes against each track budget. Each new group must begin with
an independent keyframe. A two-object bounded producer queue allows incremental
sending and cancellation without first collecting a complete GOP. Native track
cleanup retains the workload guard until capture shutdown returns.

Input payloads are at most 16 KiB; streams roll over at 8 MiB (below the existing
64 MiB request limit), retaining attachment sequence across streams. The live input reader applies small buffer/total bounds after recognizing the
canonical profile-1 start header, before buffering the complete byte string.
Clients must wait for the receipt before rollover. Noncanonical/unrecognized
initial envelopes remain subject to the existing general 64 MiB ingress limit;
complete input payloads are always checked against 16 KiB before injection.
CBOR decoders now reject lengths beyond received bytes before allocation and nesting
deeper than 64, including malicious unknown fields.

## Verified host milestone

The actual WebTransport fixture uses temporary credentials, an ephemeral local
certificate trusted only by its client, fake key events and fake encoded bytes.
It checks unauthenticated rejection, attach/workload protection, live input before
EOF, reset/oversized-input release, revocation, connection cleanup, media uni
streams and recovery after a canceled group. Unit tests additionally cover stale
sequence/epoch, viewport bounds, credential expiry, competing drain admission,
release failures, input rollover limits and cross-language codec goldens.

## Native adapters and viewer

The workbench Remote desktop entry opens the Solid 2/Bunja viewer without connecting
or requesting control. Zyzz presentation, manual multi-monitor popup windows and
popup stylesheet/theme synchronization are integrated. PNG cursor shapes are
bounded and rendered separately from video in both embedded and popup views.
Display changes release held input, advance the layout epoch and invalidate tracks.
Optional `physicalKeys` and `wheelUnits` capabilities constrain browser input;
`feedback` must be negotiated before sending the new feedback union variant.

macOS uses ScreenCaptureKit, CGEvent and hardware-required VideoToolbox H.264.
The adapter refuses root and checks active console ownership and existing Screen
Recording/Accessibility authorization without prompting. Windows uses DXGI Desktop
Duplication, SendInput and hardware-only Media Foundation H.264 transforms in an
interactive Default desktop worker. Neither adapter is installed or connected to
the production root/system runtime yet. Both currently emit one independent
keyframe per group; delta-GOP efficiency and sustained latency remain unmeasured.

The synthetic black NV12 fixture was encoded by VideoToolbox hardware, then decoded
through the actual browser receiver in an isolated Chrome profile. Its checked-in
bitstream is `web/tests/fixtures/desktop-black.h264` (640x480, black pixels only).
`desktop::tests::export_synthetic_hardware_frame` regenerates it when explicitly
run with `RIEUL_DESKTOP_SYNTHETIC_OUT`. This test never captures a display or injects
input. Bundled headless Chromium may lack H.264 and skips this codec-specific test;
that is an unsupported negotiated codec, not a successful decode assertion.

## Client codec policy

Codec preference is client policy, not a wire ordering rule. AV1 is eligible only
when the daemon reports actual hardware encoding and the client has authoritative
hardware decoding evidence for that codec configuration; otherwise H.264 is used.
`desktopCodecOrder` retains H.264 after eligible AV1. Ordinary browsers currently
supply no authoritative hardware evidence, so AV1 is excluded there, even if
`isConfigSupported` accepts `prefer-hardware`. WebCodecs explicitly allows ignoring
that hint, and Media Capabilities `powerEfficient` is not a hardware guarantee:
https://www.w3.org/TR/webcodecs/#hardware-acceleration
https://www.w3.org/TR/media-capabilities/#media-capabilities-info

Both current native adapters expose only the H.264 codec derived from an actual
hardware-produced SPS. Neither advertises AV1. A future native/browser integration
that supplies verified AV1 decoding must also implement bounded AV1 failure to
H.264 reattachment, with fresh epochs and no restored control; the current browser
path cannot select AV1 and does not pretend such a runtime fallback was tested.

## Integration work still required

- Authenticated per-user desktop IPC and production adapter selection. The system
  runtime intentionally remains Unsupported. IPC must bind peer OS identity and
  active login session, release all held state on loss, bound media/control queues,
  and preserve updater workload protection through actual native shutdown.
- macOS GUI helper/packaging integration crosses files owned by the GUI migration;
  coordinate that boundary before changing their startup and dependency graph.
- Windows x64 full package/link CI and isolated interactive GPU execution. Current
  cross-target checks cover Windows API types and the adapter; pure crop/NV12,
  key mapping, Annex-B and PNG tests run independently on the development host.
- Windows per-monitor DPI, rotated displays and monochrome/animated cursor shape
  semantics are not implemented. Current display metadata reports scale 1 / DPI 96;
  Windows input supports line-unit wheel only. macOS supports pixel and line wheel.
- Native testing needs a separate isolated fixture. The updater VM and its data are
  reserved. A new macOS arm64 guest needs an interactive user and explicitly granted
  Screen Recording/Accessibility for only the fixture helper. GPU encoding in a VM
  must be measured. Windows needs a separate licensed guest with working GPU APIs;
  ARM virtualization alone cannot validate an x64/GPU deployment.
- IME, relative pointer, OS-reserved shortcuts and real hardware latency/quality
  are not claimed. No host capture, OS input injection, permission changes or
  service installation has been performed.

GUI/packaging and updater sources remain untouched by this native checkpoint.
