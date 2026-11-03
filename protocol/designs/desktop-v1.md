# Desktop v1 user-session integration (native execution validation pending)

Desktop RPC IDs 66–72 use the existing authenticated WebTransport session. The
system runtime now selects a private user-session IPC proxy on macOS and Windows.
Construction does not capture or inject input. Capabilities remain Unsupported
when an authenticated helper, permissions or a verified encoder are unavailable.
No user host screen/input or permission settings were accessed during development.

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
interactive Default desktop worker. Both adapters are connected through private authenticated IPC; installation and
actual capture/input execution remain untested in an isolated guest. Both currently emit one independent
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

macOS currently exposes H.264 derived from an actual hardware-produced SPS. An
explicit VideoToolbox hardware-only AV1 session probe on the development Mac Studio
returned unavailable; macOS AV1 packet production is not implemented or advertised.
Windows now enumerates hardware-only AV1 MFTs as well as H.264, forces a clean-point
synthetic encode and validates a supported 8-bit main-profile sequence before
advertising AV1. Its conservative OBU parser rejects timing models, multiple
operating points and unsupported bit depths. Windows AV1 API types and pure packet
bounds are checked; real AV1 GPU encode/decode is still unverified.

The server respects the client's ordered codec list rather than choosing its own
priority. A client that supplies separately verified hardware decoding evidence can
include AV1 through `supportedDesktopCodecs`. AV1 configure/decode/encoder failure
reattaches once with H.264 and never restores control. Tests simulate verified
hardware to exercise those three failures; they do not claim browser hardware
attestation. The ordinary browser still has no authoritative evidence source, so
its automatic selection remains H.264. A trusted native decoder/browser integration
is needed before calling AV1 selection complete in the shipping browser viewer.

## Private user-session IPC

`HostUserDesktop` (private IPC ID 10) owns one input/capture lifetime. Request IDs
are monotonic, requests are bounded to 64 KiB and replies to 17 MiB. At most 16
calls and eight native group jobs are pending; reply queues hold two messages.
The root proxy never replays an operation after an established channel fails.
Loss immediately fences the old backend generation. A capability/admission check
can reconnect to an authenticated, exclusive helper in the same OS login; the
first private command releases the predecessor's possibly held keys/buttons.
The host records down events before sending and removes them only after release
acknowledgments, preserving later downs when an earlier release is acknowledged.
A new empty helper's ordinary ReleaseAll is not accepted as cleanup evidence.
Only successful recovery retires old attachments, increments input/layout epochs,
and permits new attachments without restoring control. Codec epoch cutoffs reject
old media requests; old replies cannot cross the closed channel. Uncertain native
capture guards remain owned until authenticated predecessor retirement is proven.
EOF, malformed messages, duplicate IDs, parent shutdown or missed heartbeats drain
native work, release held input and stop tracks. Failed/uncertain cleanup retains
update workload protection until successful recovery or daemon shutdown. Blocking IPC and native releases
run outside the transport's async executor. Cancellation after attach still owns
an attachment cleanup guard.

On macOS the installed GPUI app starts the existing bundled system binary in its
new `desktop-user` mode as the GUI user, using a stdin pipe to bind its lifetime.
GUI exit requests cleanup by EOF, not SIGKILL. An empty helper may restart after a
daemon update; no viewer/control state is restored. Each peer is checked using
kernel UID/PID, peer audit token, valid running-code signatures and identical code
hashes, plus the expected root-owned installed executable path and ancestors.
The standard root:admin group-writable `/Applications` container is allowed only
with this code identity check; world-writable containers and writable app contents
are rejected. Same-code and different-program socket fixtures exercise the check
without starting capture or injecting input.
The user socket directory is private, symlinks are rejected, and a file lock prevents
competing helper ownership. Console UID plus Quartz console/login state are checked;
Screen Recording and Accessibility preflight never prompts or changes permissions.

Windows starts a separate local-only desktop pipe alongside the existing user PTY
service. It verifies the LocalSystem client, active session and installed user-process
image path. Desktop pipe retirement does not terminate terminal sessions. Native
operations run on the interactive Default desktop with per-monitor DPI awareness;
display scale and line-wheel conversion use OS settings. The existing packaged user
binary and macOS LaunchServices binary are reused; no new installer component is
required. GUI/native startup source is compiled without launching the helper.

## Remaining validation and limitations

- Signed, installed macOS helper/GUI startup and permissions need a separate guest.
  The reserved updater VM and its data were not modified. A new arm64 guest needs an
  interactive fixture account and explicit Screen Recording/Accessibility permission
  for the fixture app/helper only. GPU encoder support inside that guest is unknown.
- Windows x64 native runtime and AV1 hardware MFT execution need an isolated GPU
  environment. An ARM VM on Mac Studio cannot alone prove x64/GPU behavior. No
  Windows image/license download or agreement was performed.
- Ordinary browser AV1 hardware verification is unavailable; no standard API result
  is treated as proof. Client fallback logic is implemented and tested independently.
- Helper recovery is limited to the original OS login. Cross-login migration is
  unsupported; failed authentication or uncertain cleanup stays fail-closed.
  Successful recovery requires fresh attachment and explicit control acquisition.
- Native adapters currently use one-frame GOPs. Multi-frame encoder efficiency and
  sustained hardware latency/quality remain unmeasured. Private IPC currently carries
  one bounded complete group; incremental multi-frame IPC is still needed before
  enabling longer native GOPs.
- Rotated Windows outputs and monochrome/animated cursor semantics are unsupported.
  Windows wheel supports line units, macOS pixel/line units. IME, relative pointer
  and reserved OS shortcuts are not claimed.

## Hardware decoding evidence decision (2026-11-01)

The requirement is confirmed hardware support on both ends, not merely an AV1
codec string or a power-efficiency prediction. The shipping browser therefore
selects H.264 when hardware evidence is unknown. This is a completed conservative
policy decision, but does not constitute shipping automatic AV1 selection.

| Environment/evidence                                                                                                                                | Decision                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ordinary web page: WebCodecs support, including `prefer-hardware`                                                                                   | Unknown hardware; H.264                                                                    |
| MediaCapabilities `supported`, `smooth`, `powerEfficient`                                                                                           | Prediction, not decoder identity; H.264                                                    |
| Browser brand/version, GPU name or successful fast synthetic decode                                                                                 | Insufficient evidence of the selected decoder; H.264                                       |
| Controlled native decoder or instrumented pinned browser, with hardware-only creation and successful actual output for the exact codec/profile/size | May supply verified evidence; AV1 only if the daemon also reports actual hardware encoding |
| Evidence unavailable, stale after configuration/device changes, or encode/configure/decode failure                                                  | Fresh H.264 attachment; no restored control or replay                                      |

[WebCodecs hardware acceleration](https://www.w3.org/TR/webcodecs/#hardware-acceleration)
explicitly permits ignoring the preference. [Media Capabilities](https://www.w3.org/TR/media-capabilities/#media-capabilities-information)
leaves power efficiency to the user agent, including efficient software codecs.
Neither is a portable hardware attestation API.

Chromium's current [support query implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webcodecs/video_decoder.cc)
checks GPU factories when hardware is preferred, and its [decoder broker](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webcodecs/video_decoder_broker.cc)
excludes the default software decoder factory in that mode. This is useful evidence
when auditing a controlled build, not a promise made by the WebCodecs standard or
proof supplied to an arbitrary web page. Browser forks, future changes and backend
selection must be independently validated. Do not add a user-agent allowlist or
reinterpret `powerEfficient` as verified evidence. No controlled browser bridge is
currently shipped; the existing evidence argument is an integration seam, not an
implemented evidence provider. Before adding one, bind evidence to every actual
track configuration and invalidate it on codec/layout/device changes.

## Isolated execution fixture scope

Read-only inspection found an existing Tart binary and an immutable cached macOS
base image belonging to the updater environment. Tart supports copy-on-write clones.
No clone or boot has been performed. The next proposed execution scope is:

1. Create a separate clone with its own `TART_HOME` under this desktop task, disable
   automatic pruning, and never address the updater VM or its writable disk.
2. Boot only that clone; create a disposable interactive fixture account and install
   the candidate package inside the guest. Test root/user peer authentication,
   helper lifetime, login changes and installed-path permissions first.
3. With explicit guest-only permission approval, grant Screen Recording and
   Accessibility to the fixture app/helper and run synthetic windows/input targets.
   Do not grant permissions to, capture, or inject input into the host desktop.
4. Record hardware encoder availability separately. A virtual GPU may not expose
   VideoToolbox encoding. Windows on an ARM Mac VM is not proof of Windows x64
   hardware MFT/AV1 operation; that requires a separately available x64 GPU fixture.

Guest creation/installation/permission execution remains pending; no OS image or
license has been downloaded or accepted. There is no current auto-review denial
for these unattempted actions. The remaining blocker is an approved, isolated
interactive fixture with the required OS permissions and actual GPU capability.

## Existing displays and custom OS layouts (contract foundation)

`AttachDesktop` (67) continues to attach to existing OS displays without changing
OS topology. `ConfigureDesktopViewports` remains crop/video output configuration,
not an OS display mode change. Existing request/response fields are unchanged.

The additive procedures 101–103 reserve `GetDesktopLayoutCapabilities`,
`AttachDesktopWithLayout`, and `ConfigureDesktopLayout`. **No handler is registered**:
there is no virtual display backend in this change. Clients discover each attach
mode independently through supportedProcIds, then check runtime capabilities.
The current viewer only opens existing displays, even if a future daemon advertises
custom layout. No custom request may fall back to an existing-display attachment.
Older clients ignore these absent/new procedure IDs; older Screen daemons continue
to use procedures 66–72 without a protocol version change.

Requested bounds are logical desktop coordinates; pixel dimensions are logical
size times scale (must be integral). Refresh is OS milliHz, independent of video
FPS. Keep retains physical displays and adds the requested virtual displays;
Disable makes only the requested displays active. Unsupported combinations must
fail, never silently resize video or alter the requested policy. Capability limits
are necessary constraints, not a promise every combination works.

Before registering these handlers, a backend must implement exclusive per-attach
layout ownership, authenticated idempotent operation IDs (same ID/different payload
conflicts), validation and actual-layout readback, bounded resource allocation,
layout epoch changes and input release, keyframe recovery, lease cleanup, and
conditional restoration that does not overwrite external OS changes. Attach must
not emit Attached before OS layout and capture are ready. Failed apply/restore
must report the actual outcome rather than pretend OS operations are atomic.
Configuration and restoration must participate in updater workload protection.
No automatic input-control restoration is permitted on reconnect. The mode shares
the logged-in desktop; it is not a separate OS login session.

Windows requires a real IDD/IddCx backend and its packaging/validation. macOS public
virtual-display creation support remains unconfirmed; existing display mode APIs
are insufficient evidence. Neither drivers nor OS configuration are changed here.
