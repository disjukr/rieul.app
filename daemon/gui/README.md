# Native GPUI port (work in progress)

This isolated Cargo workspace builds the native GUI used by the desktop packaging scripts. Run only with a disposable, explicit `--config` file. No real daemon,
service registration, user data, or security setting is required by its tests.

```sh
cargo test --manifest-path daemon/gui/Cargo.toml --lib --locked
cargo run --manifest-path daemon/gui/Cargo.toml --features native --locked -- \
  --config /tmp/rieul-gpui-fixture/rieul.yaml --show
```

The separate lockfile prevents GPUI's newer dependencies from changing the system
daemon's dependency graph. Node remains a **build-time** requirement of the shared
BDL protocol generator; it will not be needed in the final GUI runtime bundle.

## Implementation

The controller and Tokio transport use the existing Rust IPC models, strict
validation before mutation, generation-scoped replies and notification fallback.
Replacement, disconnect, close and process shutdown reject outstanding requests.
The single native process owns the window, tray and IPC listener. There is no
launcher/Node/Bun descendant process or runtime image lock to clean up.

The view preserves original dimensions, gradient, shadows, text and QR encoding.
A small Element wrapper reports disabled controls to AccessKit while also blocking
pointer/keyboard activation. Tab/Shift-Tab and Enter/Space use GPUI focus handling.

## Dependency selection evidence

Official crates.io `gpui = 0.2.2` compiled through its framework code on this Mac
but does not contain the AccessKit/accessible-label APIs required to preserve the
current GUI. It is not an acceptable final dependency for the port.

Official Zed commit `025d2a06ee7920777bf4947f11e46a1f52e62cbb` has
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
at this revision declare Apache-2.0; a complete transitive license bundle is included in each native package.

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
  signing, CI and release native QA previously required the JavaScript payload.
  They now build and validate the native payload together.
- Preserve the Windows native WNDPROC event queue from `635ba591`; no JS or Rust
  UI re-entry inside OS window callbacks.
- Retain hardened signing, permission checks and notarization. Remove obsolete
  Node/Bun-specific JIT entitlements only as part of native payload packaging.
  Do not weaken library validation or alter the installed app's security identity.

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

Workspace `pnpm install --frozen-lockfile` succeeds with the repository's pinned
pnpm 10.28.0. The earlier minimum-release-age rejection came from a fallback pnpm
11.25.0. No lockfile, release-age policy, web dependencies or Vercel settings changed.

## Native packaging checkpoint

The package builder now ships Rust GPUI, assets and dependency license notices;
Node/Bun and JS modules are absent. The existing GUI executable paths and bundle
identity are unchanged. The private pairing/bundle.json schema is now v2:
implementation, platform, arch, gpui_revision, executable_sha256 and files.
The root updater uses its separate signed update manifest and unchanged launcher
identity; its source and recovery protocol are not modified. Signing refreshes the
GUI digest before sealing the outer app, and no JIT entitlements are needed.

Mac ARM64 disposable-profile QA has passed native pointer approval, rejection,
cancel, close/hide/reopen, stale generation, duplicate activation and independent
profile shutdown. Tests use the native renderer and event dispatch, not OS-input
injection. Cross-platform CI and final visual parity remain in progress.

The official GPUI pin precedes the CAMetalDisplayLink change in 0373366f43;
that newer renderer aborts when screenshot readback runs on this Mac. The pinned
revision retains AccessKit support and passes screenshot capture and clean exit.
