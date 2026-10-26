# Verification record

The default desktop build and installer paths use GPUiX + Solid with embedded, pinned Node/Bun runtimes. Legacy utility source, configuration, dependencies and launcher fallback have been retired. Git history and the user's installed software are untouched.

## Verified evidence

[CI 40314216502](https://github.com/disjukr/rieul.app/actions/runs/40314216502) passed for commit `45ad7c49003e1b7e8bd608089f856128040a980c` on Windows x64, macOS ARM64 and macOS Intel. The final retirement changes receive a separate same-commit CI gate before integration; see [MIGRATION.md](./MIGRATION.md) for the chronological record.

- Controller: 9 tests / 468 assertions, strict malformed-payload preservation, replacement/cancellation, stale response protection, notifications and four bindings.
- Node IPC/parser: 7 tests, actual profile-scoped pipes, fragmented/half-closed connections, duplicate activation, explicit rejection on disposal, isolation, timeout and Mach-O floor parsing.
- Rust launcher: 2 tests; daemon core: 44 tests.
- Windows native GPUiX: empty PATH/home/cache, relative config from caller directory, QR dimensions, icons/window styles, three repeated replacement/accept/reject cycles, native close/hide/reopen, disconnect, duplicate activation and pending-request rejection on Quit.
- Windows lifecycle: corrupted manifest and traversal rejection, forced root exit terminates owned children, runtime upgrade file locks released. Default MSI/MSIX creation and extraction/payload verification passed without installing them.
- Both Mac architectures: full bundled Mach-O minimum target <=13.0, AppKit bridge/delegate forwarding and application-reopen proxy fixtures, isolated native UI repeated flows, profile activation and shutdown. Default PKG creation, ad-hoc/hardened signing, extraction and native UI execution passed. Complete DMGs passed mounted payload/codesign checks and hdiutil verify.
- Local encoded/space-path build and profile-scoped developer process selection fixtures passed. Generated icons remained byte-identical.

The final cleanup also adds two simultaneous native profile processes to the Windows/Mac QA scripts. Their final CI result must be checked before claiming this additional case passed.

## Limits

- Native fixture clicks, bridge commands and app-generated captures do not prove actual OS tray popup selection, notification appearance, associated editor display or clipboard behavior. Native computer UI access is disabled in the available tooling.
- No actual MSI/MSIX/PKG install, upgrade, uninstall, service/LaunchAgent registration or autostart changes were performed. Archive extraction and owned-process/lock tests are distinct from installation lifecycle tests.
- No Developer ID signing, notarization or Gatekeeper assessment. macOS 13 itself was not run; deployment targets were checked and native execution used macOS 15 CI.
- Windows cross-user/integrity named-pipe ACL behavior was not tested. Existing profile identity and OS default ACL policy are preserved.
- No real device pairing, credentials, user daemon data or persistent device access was used or changed.

Local artifacts and fake fixtures remain ignored, not committed. This record distinguishes OS-visible behavior and signed release distribution from the native integration and package checks actually performed.
