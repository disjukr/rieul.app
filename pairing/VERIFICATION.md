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

Two simultaneous native profile processes also passed the Windows and both Mac native QA stages of [CI 40321282237](https://github.com/disjukr/rieul.app/actions/runs/40321282237), including signed extracted Mac payloads. One profile's approval/exit leaves the other's pending request and window intact. That run's Windows packaging later failed at directory publication with EPERM; this is not recorded as a full CI pass. Publication now uses bounded Windows-only lock retries and preserves both payloads on failure; two filesystem regression tests cover successful retry and rollback after persistent failure.

Local web type checks, Node tests and Vite production build passed after retirement. Four browser regression tests passed using already-installed official Chromium1243 with an isolated profile and the correct web configuration. The pinned Chromium1194 download was initially unavailable; the normal web CI installs its pinned browser. Root ESLint has 198 errors in files byte-identical to the existing main baseline; pairing ESLint and changed-file formatting passed.

## Actual Windows OS UI audit

DMG cleanup also has three image/device identity regressions and eight scoped shell lifecycle fixtures. A DiskArbitration timeout is not treated as success unless the OS image inventory confirms the owned image is absent. Attached devices are checked against canonical image identity before detachment; malformed/unknown state fails closed. Other/reused devices are not detached. These tests complement the real Mac image build/verification gate.

A separate Computer Use audit operated the isolated fake-IPC profile on source727bc8c, recorded in task-6/ui-evidence/observations.json and events.json outside this repository. Actual OS input verified the QR/fixture URL window, correct code returning true, incorrect code showing mismatch and returning false, Cancel returning false, titlebar X hiding/same-profile activation reopening, and pending Alt+F4 returning false. Open config visibly opened only the fixture YAML in the associated editor. Copy URL pasted the exact fixture URL into a fresh scratch tab; previous clipboard contents were not read or retained. Test windows/processes/editor tabs were cleaned up; no actual daemon/account/install was changed.

The audit found P3 feedback ambiguity: Cancel rejected correctly but displayed the same completion text as approval. The view now distinguishes "Pairing cancelled." from "Approval sent." Windows and both Mac native QA scripts assert the distinct messages and absence of approval feedback after Cancel across three repeated flows. This label correction is subject to its successor CI; it is not claimed as a repeated OS-input audit.

## Appearance restoration checkpoint

The packaging baseline `4d4019d` passed Windows x64, macOS ARM64 and Intel in
[CI 40346452662](https://github.com/disjukr/rieul.app/actions/runs/40346452662),
including complete DMGs and distinct approval/cancellation feedback. This pass
predates the visual restoration and is not its final validation.

The original React/UnoCSS source at `2b938439` supplies the restored 640×360
window, 18px inset, translucent panel, colors, typography, 146px QR in a 168px
frame, property rows, candidate layout and expiry badge. GPUiX approximates
radial backgrounds with sampled pixels and code letter spacing with native
digit gaps; native fonts, shadows and backdrop compositing can differ. Cancel,
Daemon info and Close remain available to preserve current lifecycle behavior.
The controller and IPC are unchanged. Native QA checks the restored QR size on
both platforms and retains approval, rejection, cancellation and profile tests.

Type checking, 15 Node regressions, 9 Bun controller tests (468 assertions), and
the Solid/native UI bundle build passed locally. Bun stalls before JavaScript
in the Documents checkout but the identical sources and installed dependencies
build and test successfully in a disposable `/tmp` copy; no security settings
were changed. Reference screenshots and the detailed comparison remain outside
Git. Actual Mac CUA comparison is pending manual screen unlock and the separate
visual review; source matching and app-generated CI captures are not OS-input
or pixel-perfect proof. The restored revision requires its own all-platform CI.

## Remaining limits

- Actual tray popup selection/Quit and visible OS notification/click remain unverified: documented CUA inventory did not expose taskbar/notification-area windows. No workaround was used. Mac OS-visible interaction remains unverified; its native fixtures and app-generated captures are distinct from OS-input proof. Windows editor/clipboard and close/reopen behavior were verified in the audit described above.
- No actual MSI/MSIX/PKG install, upgrade, uninstall, service/LaunchAgent registration or autostart changes were performed. Archive extraction and owned-process/lock tests are distinct from installation lifecycle tests.
- No Developer ID signing, notarization or Gatekeeper assessment. macOS 13 itself was not run; deployment targets were checked and native execution used macOS 15 CI.
- Windows cross-user/integrity named-pipe ACL behavior was not tested. Existing profile identity and OS default ACL policy are preserved.
- No real device pairing, credentials, user daemon data or persistent device access was used or changed.

Local artifacts and fake fixtures remain ignored, not committed. This record distinguishes OS-visible behavior and signed release distribution from the native integration and package checks actually performed.
