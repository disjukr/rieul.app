# Native GPUI port (work in progress)

This isolated Cargo workspace is not wired into the production GUI launcher or
installers. Run only with a disposable, explicit `--config` file. No real daemon,
service registration, user data, or security setting is required by its tests.

```sh
cargo test --manifest-path daemon/gui/Cargo.toml --lib --locked
cargo run --manifest-path daemon/gui/Cargo.toml --features native --locked -- \
  --config /tmp/rieul-gpui-fixture/rieul.yaml --show
```

The separate lockfile prevents GPUI's newer dependencies from changing the system
daemon's dependency graph. Node remains a **build-time** requirement of the shared
BDL protocol generator; it will not be needed in the final GUI runtime bundle.

## Implementation checkpoint

- Toolkit-independent request controller, using existing Rust IPC models.
- Validation before state mutation, generation-scoped confirmation replies,
  cryptographically seeded candidate randomization, rejection on replacement,
  close, peer disconnect and disposal, and generation-scoped notification fallback.
- Tokio socket transport using the existing CBOR sequence and stream IDs. Tests
  cover fragmented requests, half-close rejection, and duplicate activation.
- Unix socket ownership/type checks and inode-aware cleanup. Windows named-pipe
  implementation is present but requires Windows validation and contention tests.
- A macOS GPUI view and statically linked existing AppKit lifecycle bridge are
  under construction. macOS ARM64 `cargo check` and `cargo build --features native
  --locked` passed with Rust 1.99.1. A five-second startup check passed, followed by
  an actual native-process IPC smoke test: activate, show pairing code, replace a
  pending confirmation with daemon info, and receive a false confirmation reply.
  The smoke run emitted no stderr and terminated only its owned fixture process.
  These checks do not establish screenshot/OS-input parity.

## Dependency selection evidence

Official crates.io `gpui = 0.2.2` compiled through its framework code on this Mac
but does not contain the AccessKit/accessible-label APIs required to preserve the
current GUI. It is not an acceptable final dependency for the port.

Official Zed commit `a4b39c38e0056a5631a6f49f7fb13d4d1c4b6a9c` has
`StatefulInteractiveElement::{role, accessibility_id, aria_label}`, tab navigation,
and macOS/Windows AccessKit adapters. GPUI and the target platform crate are
pinned to this exact commit. GPUI's upstream toolchain is 1.98.1; this machine has
1.99.1. The `gpui_platform` convenience crate pulls in unrelated Linux/web/WGPU
resolution, so the Mac prototype constructs its official `MacPlatform` directly.
No component framework such as gpui-box is needed for these three screens.

The Mac prototype selects upstream's `runtime_shaders` feature because the local
machine has Command Line Tools, not full Xcode/Metal tools. It compiles Metal
shaders through the supported runtime API, without changing OS security settings.
Final release shader choice, startup timing, target OS, and signed execution still
need validation. Upstream GPUI/platform, zlog, ztracing and ztracing_macro manifests
at this revision declare Apache-2.0; a complete transitive license bundle is still
required before packaging.

## Packaging / updater coordination contract

Preserve these public artifact identities when switching implementations:

- macOS: `Rieul.app`, bundle ID `app.rieul`,
  `Contents/MacOS/rieul-gui`; keep the existing installer/bootstrap/system-daemon
  identities, LaunchAgent arguments, profile hash and config paths.
- Windows: `gui/rieul-windows-gui.exe`; preserve existing MSI component/shortcut,
  HKLM Run, system/user daemon identities and named-pipe profile endpoint.
- Introduce a versioned native payload manifest rather than accepting the old
  manifest's Node/Bun version fields as proof of native payload integrity.
- `pairing/scripts/package.mjs`, bundle verification/publish/refresh/permission
  scripts, both OS development launchers, MSI/MSIX verification, Mac PKG/DMG
  signing, CI and release native QA all currently require the JavaScript payload.
  Switch them together only after native lifecycle and screenshot parity pass.
- Preserve the Windows native WNDPROC event queue from `635ba591`; no JS or Rust
  UI re-entry inside OS window callbacks.
- Retain hardened signing, permission checks and notarization. Remove obsolete
  Node/Bun-specific JIT entitlements only as part of native payload packaging.
  Do not weaken library validation or alter the installed app's security identity.

No packaging, updater, production GUI launcher, web client, credentials, Vercel
configuration, installed app or services have been modified in this checkpoint.

## Remaining gates

1. Finish the native view, disabled/focus semantics, shadows, icons,
   QR scaling, expiry timer and all original text/layout/state transitions.
2. Finish Windows tray, balloon notification, Explorer restart, window icon,
   close guard and config launch integration; preserve native callback ownership.
3. Match safe fixture screenshots against the existing GPUiX 640×360 screens;
   verify clipboard, config editor, notification failure/click, tray activation,
   close/reopen, keyboard/screen-reader behavior and multi-profile shutdown.
4. Port automation and payload integrity tests; verify empty PATH/cache execution.
5. Switch packaging only after coordinating with the updater work; run macOS ARM,
   Intel and Windows CI and installer fixture checks. Never install on this host.
6. Compare same-architecture/release/signing-condition daemon, GUI, whole app and
   compressed installer bytes. No size reduction has been measured yet.

## Local checkpoint evidence (2026-11-01)

Base: rieul.app main `d381b3278c5c62003682094254b8aa5cc1d187ad`.
Branch: `codex/daemon-gpui`, isolated checkout on rieul-macstudio.local.
`cargo test --manifest-path daemon/gui/Cargo.toml --lib --locked`: 9 passed.
Native smoke evidence: ignored `tmp/gpui-fixture/native-smoke.json`.
The smoke fixture's first assertion used response payload key 1; corrected to
protocol key 2 and rerun successfully. This was a fixture error, not a protocol
implementation change.

Full workspace `pnpm install --frozen-lockfile` was rejected by pnpm's minimum
release-age policy for `bunja@4.0.0-alpha.2`. No policy or web dependency was
changed. The unrelated existing BDL 0.8.3, YAML 1.0.12 and tsx codegen dependencies
were used read-only from the other checkout to run Rust protocol generation.
The native GUI binary does not launch Node or Bun.
