# Desktop v1 checkpoint (not enabled)

This change defines proposed IDs 66–72, generates Rust/TypeScript codecs and adds
isolated state-machine/media tests. The daemon does **not** register these RPCs or
advertise desktop support yet. No real desktop is captured and no OS input is sent.

## Contract

`GetDesktopCapabilities`, `AttachDesktop` (server events),
`ConfigureDesktopViewports`, `SetDesktopControl`, `RenewDesktopLease`, and
`DetachDesktop` use ordinary RPC. `WriteDesktopInput` describes ordered streaming
input. The incremental host dispatcher for this proc is still to be implemented;
it must not use the existing whole-stream buffering path.

Attach explicitly negotiates profile 1, uni-stream media, browser-supported codecs
and a physical/text keyboard mode. Pairing grants access, while live credential
expiry/revocation and OS screen/input permission checks remain mandatory. No
per-session local approval or separate input/view grant exists.

One connection-bound attachment holds control. Viewing never takes it. Explicit
takeover releases all held state before advancing the epoch. Expiry, revocation,
detach and connection loss release control. A release failure fails closed and
retains the workload guard. Reconnect creates a fresh attachment and does not
restore control. The hosting actor must serialize operations, run expiry timers,
stop capture before dropping an attachment, and explicitly disconnect on shutdown.
The pure state machine is not yet wired to those lifecycle hooks.

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

Input payloads are at most 16 KiB; streams roll over at 8 MiB (below the existing
64 MiB request limit), retaining attachment sequence across streams. The receiver
must reject overlong framing *before* buffering payloads, serialize successor
streams and return a receipt before rollover. `InputStreamBudget` bounds complete
payload decoding; it is not yet a replacement for the host's stream reader.
CBOR decoders now reject lengths beyond received bytes before allocation and nesting
deeper than 64, including malicious unknown fields.

## Integration work still required

- Host capability RPC, attach event lifecycle, live credential store adapter, timer,
  input-stream incremental framing, cancellation and connection cleanup.
- Share the existing maintenance `WorkGate` for the entire attachment lifetime;
  do not add a separate check-then-act workload flag. Tests cover concurrent drain.
- Native capture/input and hardware encoder negotiation on Apple Silicon macOS and
  Windows x64; explicit unsupported status elsewhere. OS permissions are not bypassed.
- Actual QUIC/WebTransport integration fixture, including stream reset, disconnect,
  credential revocation while held and queue pressure. Present tests use fragmented
  in-memory transport and fake encoded bytes, not a real encoder or network.
- Solid 2/Bunja viewer, WebCodecs negotiation, cursor overlay, per-track feedback,
  group scheduling/cancellation and optional multi-window placement.
- Native testing requires a separate isolated desktop fixture. The updater VM is
  reserved for another task and must not be modified. No host capture is authorized.

`daemon/host/src/server.rs` and `maintenance.rs` remain untouched for coordination
with the updater work; GUI/packaging sources are untouched.
