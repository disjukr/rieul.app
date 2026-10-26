# Runtime migration progress

Continuation from main `2b938439e2aae31b368cb6bbdfdeec07e35d3102`, isolated task-5 checkout, branch `codex/runtime-migration`.

## Completed implementation

- Official Node 24.13.0/Bun 1.3.9 runtime archive hashes pinned for Windows x64 and macOS ARM64/x64; downloaded archives are verified before extraction. Bundle launcher uses absolute paths and verifies runtime/platform/architecture and critical file hashes.
- Native GUI executable contract `gui/rieul-windows-gui.exe`; Windows process-local Job owns the host/UI descendants, including forced launcher exit. macOS launcher layout prepared for Resources/pairing runtimes and app payload.
- Windows/macOS common host and OS open/clipboard adapters. AppKit window delegate forwarding/status item implementation enabled in source. Notifications only query existing authorization; no new permission request.
- Original assets/types preserved, copied for the replacement. No user daemon/profile/autostart/service changes.

## Actual verification completed

Windows complete bundled executable, official embedded runtimes, restricted PATH and empty HOME/cache: native fixture QA passed (`artifacts/qa-1793003786847/evidence.json`). Includes QR dimensions, three replace/accept/cancel cycles, close-to-hide/reopen, malformed request preservation, disconnect, duplicate activation and native tray Quit command. This does not prove OS popup selection or displayed notification.

Initial Windows verbatim path startup failure was fixed in the Rust launcher before that pass. Initial failed evidence is retained separately and not counted as a pass.

## In progress / not yet passed

- macOS Cocoa bridge compile, Metal/GPUiX live QA and Intel official source build: test sources prepared; CI workflow not yet launched.
- Replacement MSI/MSIX/DMG/PKG integration, signing traversal and extracted-payload validation.
- Dev/kill scripts, documentation and old implementation removal after replacement verification.
- Final regression/lint/type/build/packaging gates and main integration.

## Exact restrictions

The available CUA tool explicitly disables native computer APIs; refreshed inventory exposes browsers and no native app surface, and no callable node_repl/Sky tool exists. Actual OS tray popup selection, notification appearance and associated editor screen cannot currently be verified through a supported UI surface. No bypass attempt is counted as proof.

Auto-review rejected moving `web/desktop/icon.ico`, `web/desktop/tray.png`, `web/src/desktop-bindings.d.ts` before replacement verification because that could break the protected old path. The whole command was rejected before execution. Safer copy-only staging was accepted; originals remain untouched. Default-switch/removal will be revisited only with the new replacement verification evidence and the user's current explicit full-migration authorization. No rejected move has been retried.

No main push of this continuation has occurred yet. Prior opt-in main remains intact.

## Recovery checkpoint 2026-10-26 (actual results)

- Branch b9766254c477f7b9e89ef4d285d2f7046fbb1f31 CI 40295640095: Windows success; macOS ARM64 success including bundled GPUiX/AppKit repeated lifecycle; Intel official source compile, bridge fixture, bundle and integrity checks success, final screenshot failed because production build excluded test-support. Corrected to upstream published build feature set; next run pending.
- Windows unsigned MSI generated (87,525,886 bytes) and decompiled without installation: dist/windows-gpuix-probe/rieul-windows-desktop-0.1.0.msi; tmp/msi-unpacked/File contains 3,754 extracted files. No service/installer execution.
- Bundled Windows forced launcher termination/integrity/traversal QA passed; runtime image write locks released after 61ms bounded poll. This is not an installed upgrade test.
- Local MSIX invocation was denied before script execution by PowerShell AuthorizationManager (UnauthorizedAccess). No execution-policy change or retry. CI packaging verification remains to be added.
- Official Node 24.13.0 BUILDING.md requires macOS >=13.5, incompatible with existing advertised 13.0. Embedded runtime changed to official SHA-pinned Node22.22.0 (official support >=11.0); build tooling remains Node24. Added actual Mach-O deployment target CI assertion <=13.0. New runtime bundle checks not yet passed.
- Default CEF/Deno paths remain preserved; complete removal/main switch not yet completed. No new main push. Current edits are runtime compatibility and candidate packaging source only.
