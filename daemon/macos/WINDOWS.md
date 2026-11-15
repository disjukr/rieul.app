# Read-only Windows tab

The macOS system daemon shares the existing authenticated desktop helper Proxy
with Screen. It never opens a second helper connection or queries WindowServer
as root. Opening Windows sends a numbered private Ping to negotiate metadata
support, then a private WindowSnapshot request. The optional Ping reply field is
ignored by old clients; old helpers return an absent field and never receive an
unknown command. Public RPC procedures remain 26 and 27.

The helper uses `CGWindowListCopyWindowInfo(optionAll | excludeDesktopElements)`.
It retains normal-layer windows with a valid number/PID and positive bounds,
including titleless and offscreen windows. A missing title stays missing; the web
client labels the row with its PID rather than fabricating a title. On-screen
visibility is not minimized state. Focus, minimized, and maximized remain unknown.
There are no ScreenCaptureKit, image capture, Accessibility, focus/control, or
permission-request calls in this metadata path.

IDs contain a random helper epoch, window number, and PID. The helper and root
service each fence reads with the console UID and `/dev/console` change timestamp;
the helper also checks the current Quartz session's on-console and login-done
state. Reads are checked before and after, including before root cache reuse.
Once a transition is seen, that fence stays retired. A helper/channel generation
change discards in-flight results and caches. Metadata polling never invokes
input recovery. This is not a claim of lock-screen detection.

List/detail subscribers share a one-second cache. There is only one in-flight
native metadata worker, separate from encoder probes and Screen groups. Scans
reject more than 8192 raw entries or 512 retained rows, titles are bounded to
512 UTF-8 bytes, and native JSON is bounded to 512 KiB. Overflow/failure produces
an error, never a silently truncated or empty snapshot. Late metadata replies
are discarded without expiring the shared Screen connection. A removed row or
Closed event means no longer in this enumeration scope, not proof of destruction.

## Synthetic checks

These commands do not inspect user windows, request permissions, capture pixels,
or inject real input:

```
cargo test -p rieul-macos-daemon --lib windows --locked
cargo test -p rieul-daemon-host --lib --locked
node --import tsx --test scripts/codegen/tests/codegen.test.ts
```

The native fixture feeds dictionaries into the same converter as the live
adapter. Rust fixtures cover titleless/offscreen/unknown fields, overflow,
duplicate IDs, session transitions, and shared caching. Private channel fixtures
cover legacy wire negotiation, a delayed read concurrent with synthetic Screen
calls, and timeout isolation. Browser fixtures use offline synthetic transport.
No actual window inventory is collected by CI.

## API references

- [Quartz list scope and options](https://developer.apple.com/documentation/coregraphics/window-list-option-constants)
- [Window metadata API](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))
- [Fast user switching and Quartz session identity](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/FastUserSwitching.html)
