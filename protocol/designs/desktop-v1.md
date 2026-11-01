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
current group, resets the decoder and requests a new keyframe through the adapter.
The current class exposes that callback, but no WebCodecs adapter is connected.
The host limits each track to one producer/send operation, times out blocked media
streams, and paces bytes against each track budget. Each new group must begin with
an independent keyframe. Native encoder compliance is not yet verified.

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

## Integration work still required

- Native capture/input and hardware encoder adapters on Apple Silicon macOS and
  Windows x64, plus per-user desktop IPC and OS permission reporting. The production
  server intentionally constructs the runtime without an adapter.
- Dynamic display discovery/layout epochs and cursor production.
- Solid 2/Bunja viewer, WebCodecs negotiation/decoding, input capture, feedback
  handling and optional multi-window placement. Feedback, composition and relative
  pointer events still return Unsupported; no frontend claims these work.
- Native testing requires a separate isolated desktop fixture. The updater VM is
  reserved and must not be modified. A macOS arm64 guest needs an interactive user
  session and explicitly granted Screen Recording/Accessibility permissions for
  the fixture helper; hardware VideoToolbox availability must be measured rather
  than assumed in a VM. Windows x64 needs a separate interactive guest and verified
  capture/input/Media Foundation GPU encoder availability.
- Real hardware latency/encoding quality, IME and OS-reserved shortcuts remain
  unverified. No host capture or OS permission changes have been performed.

`server.rs` now owns desktop RPC/stream wiring and uses the existing WorkGate.
`maintenance.rs`, updater implementation and GUI/packaging sources remain unchanged.
The only Cargo dependency addition is test-only `url`, already present in the lockfile.
