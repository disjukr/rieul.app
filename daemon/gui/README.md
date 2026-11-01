# Native GPUI daemon GUI

Supported desktops are macOS 13+ on Apple Silicon (arm64) and Windows x64.
Intel Macs are unsupported; legacy releases and user data are preserved.

This isolated Cargo workspace builds the native GUI used by the desktop packaging scripts. Run only with a disposable, explicit `--config` file. No real daemon,
service registration, user data, or security setting is required by its tests.

```sh
cargo test --manifest-path daemon/gui/Cargo.toml --lib --locked
cargo run --manifest-path daemon/gui/Cargo.toml --features native --locked -- \
  --config /tmp/rieul-gpui-fixture/rieul.yaml --show
```

The separate lockfile prevents GPUI's newer dependencies from changing the system
daemon's dependency graph. Node remains a **build-time** requirement of the shared
BDL protocol generator; it is not included in the GUI runtime bundle.

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
resolution, so the GUI constructs the official `MacPlatform` or `WindowsPlatform` directly.
No component framework such as gpui-box is needed for these three screens.

The macOS build selects upstream's `runtime_shaders` feature because the local
machine has Command Line Tools, not full Xcode/Metal tools. It compiles Metal
shaders through the supported runtime API, without changing OS security settings.
The hardened, ad-hoc signed macOS ARM64 installer fixtures run with
this feature and pass the macOS 13.0 deployment-target check. Upstream GPUI/platform, zlog, ztracing and ztracing_macro manifests
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

## Validation status (2026-11-01)

Base: rieul.app main `d381b3278c5c62003682094254b8aa5cc1d187ad`.
Branch: `codex/daemon-gpui`, isolated checkout on Mac Studio.

- Controller, transport and payload-integrity unit tests: 12 passed locally.
- Native fixture QA covers duplicate activation, copy with clipboard restoration,
  Tab/Enter activation, approval, wrong code, cancel, close/hide/reopen, stale
  generation rejection and independent profile shutdown. It launches with a
  disposable explicit config and a PATH without Node or Bun.
- A source checkout with spaces and Korean characters builds and verifies its
  actual GUI payload, using the same pinned lockfile and protocol generator.
- Historical macOS ARM64 and Intel jobs passed at `8daca9956f90f56a4b11a9a330eceb850de21dd1`:
  [CI run](https://github.com/disjukr/rieul.app/actions/runs/41275615104).
  These include signed PKG extraction, GUI execution from that payload, strict
  signature/entitlement checks and DMG verification, without installation.
- Windows x64 payload, spaced Unicode source build, native window/IPC lifecycle,
  MSI/MSIX build and extracted payload verification passed at `45b5976`:
  [CI run](https://github.com/disjukr/rieul.app/actions/runs/41278168317).
  The initial `0xC0000139` loader failure was fixed by restoring GPUI's official
  `windows-manifest` feature, including Common Controls v6 for TaskDialog.
- macOS ARM64 passed again at `098ed6d`, including signed installer fixtures.
  Current exact-commit platform results are linked from [PR #46](https://github.com/disjukr/rieul.app/pull/46).
  Fixture artifacts use a module-relative path so CI uploads do not depend on
  whether the script runs from the repository or `pairing/` directory.


Screenshots use an independently built GPUiX baseline from the base commit and the
same disposable config, dimensions and font environment. The daemon-info screen
matches all 230,400 pixels exactly. Other states preserve layout and text; random
candidate glyphs and pointer hover state must be controlled or excluded from pixel
comparisons. Local images and comparison data are in ignored `tmp/gpui-visual/`.

Separate macOS OS-input checks exercised accessible buttons, clipboard copying
(and restoration), opening the exact fixture config in its default editor, wrong
code rejection with disabled candidates and titlebar close-to-hide. Renderer QA
is not an OS-input audit. Tray/notification behavior and Windows runtime results
must not be inferred from macOS screenshots.

The same-architecture, release, ad-hoc signed comparison at `a99c493` uses the same
daemon build: app 270,516,769 → 45,793,955 bytes; PKG 90,124,675 → 15,497,300 bytes.
This includes dependency notices and keyboard fixes. No host installation or release is part of
these checks.

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
injection. The PR records exact-commit CI results for macOS arm64 and Windows x64. Intel CI
was removed when Intel Mac support was discontinued; its older checkpoints above
are historical. Renderer QA waits for the current generation to be drawn before
dispatching input, and bounds each IPC response wait.

The official GPUI pin precedes the CAMetalDisplayLink change in 0373366f43;
that newer renderer aborts when screenshot readback runs on this Mac. The pinned
revision retains AccessKit support and passes screenshot capture and clean exit.
