# Current checkpoint: final retirement

This is a chronological log; older pending/blocked entries below are superseded by this checkpoint. Commit 45ad7c49003e1b7e8bd608089f856128040a980c and CI https://github.com/disjukr/rieul.app/actions/runs/40314216502 passed Windows and both Mac architectures, including full DMG verification. The prior fallback/asset retirement approval blocks were resolved after new all-platform verification evidence; the fallback and 13 legacy files are now removed in the final working tree. No permission block remains.

Final cleanup removes the old Vite entry/types/dependency and all active runtime references, adds bounded own-image DMG detach recovery, and adds simultaneous native profile QA. Final same-SHA CI and parent independent review precede main integration. See VERIFICATION.md for actual evidence and explicit remaining limits. Root lint reports 198 existing errors only in unchanged files; no pairing lint errors. Local browser verification initially stopped before tests because the pinned browser binary was missing; four tests subsequently passed with installed official Chromium1243 and isolated test configuration.

Retirement commit702305a CI40321282237 passed all native UI stages, including both simultaneous profiles and signed extracted Mac payloads. ARM64 Mac completed full DMG verification. Windows packaging subsequently failed publishing the newly verified directory (EPERM); old payload rollback succeeded. A bounded Windows-only lock retry and two real-filesystem fault-injection tests now cover publication recovery and persistent-failure rollback, without deleting either payload or retrying unrelated/path errors. Final successor CI is the integration gate.

---

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

## Additional verified work

- Node22.22.0 bundled Windows build tmp/complete-bundle-3 verified. Full fixture native QA passed: pairing/artifacts/qa-1793006311278/evidence.json (3 replacement/accept/cancel cycles, close/reopen, malformed pending survival, disconnect, duplicate activation, native Quit command). A prior QA helper run failed because its own Bun path was absent; corrected by specifying the bundled Bun absolute path. Failed result is not counted.
- Bundle3 integrity/traversal/forced launcher cleanup passed; runtime upgrade file locks released after 63ms.
- SHA256 comparison verified all 3,752 extracted MSI GUI payload files against bundle2. No MSI execution.
- Typecheck passed; controller 9 tests/468 assertions and Node IPC5 + Mach-O parser1 tests passed. Rust launcher2 tests passed.
- CI40297980044: Windows passed. ARM64 failed in new OS-floor checker because the checker misread LC_BUILD_VERSION linker tool version1167.5 as OS floor; fixed parser and added regression excluding linker/SDK/dylib versions. Intel official build remains running as of this checkpoint. No unsupported OS floor is assumed yet.
- Added candidate Mac PKG/signing/extracted-payload CI, Windows unsigned MSI/MSIX payload CI and per-instance Mac notification identifiers. These source additions are not yet CI-verified. Existing CEF/Deno defaults remain intact.

## Packaging hardening checkpoint

- Rebuild publication passed on owned tmp/complete-bundle-3: previous bundle preserved at tmp/complete-bundle-3.previous-1793006881427, replacement verified before publication. No recursive deletion. Replacement rejects links/paths outside this checkout's tmp/target tree.
- Existing web/codegen25 tests, web/tool/codegen TypeScript checks and Vite build passed; new scripts ESLint/Prettier and shell syntax checks passed.
- Runtime-only fresh extraction validated Node22.22.0/Bun1.3.9 architecture/version and bundled license notices. Bun notice copied unchanged from official bun-v1.3.9/LICENSE.md, SHA2567068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb; Node notice comes from checksum-verified official archive.
- Mac notification identifier now per instance; bridge retains original window delegate until disposal and ignores authorization callbacks from disposed generations. Source review only until subsequent macOS CI.
- Follow-up CI40299931391 (66af754) is pending behind the still-running official Intel source build40297980044. No installed app, service, autostart, security setting, or real pairing modified. No main integration/default switch yet.

## Development launcher migration (fixture-tested, no daemon started)

Windows dev/kill now use the verified native bundle EXE and absolute config argument; removed global Deno cache/module process scanning. Both predicates require the same checkout executable and whole config-path argument, including the same-prefix/different-profile regression. Ten fake CIM cases passed without start/stop calls.

macOS dev uses the native bundle's inner GUI entry point. Kill/cleanup validates this checkout's executable/host and whole profile arguments, rechecks command identity before signals, and removes broad port-based matching. Eight pure shell fixtures including Korean/spaced paths and wrong profile/port passed via Git Bash. All affected shell/PowerShell files parse. Actual macOS dev service start/stop is deliberately not executed.

These changes are staged implementation for review; main still has the previous defaults and old CEF source remains available. Installer candidates and Intel/OS-floor/signed-payload CI must still pass before final default/removal integration.

## Review response / verified checkpoint 2026-10-26 09:55 UTC

- CI40300524070 Windows job SUCCESS, including unsigned MSI + MSIX generation, MSI extraction/hash verification and extracted MSIX GUI --verify-bundle. No installer execution or service registration. Overall workflow remains failed/pending because macOS bridge deployment floor is15.0.
- CI40297980044 Intel official GPUiX test-support compile completed successfully; its actual failure was own bridge Mach-O minimum15.0, not runtime support proof. ARM64 latest40300524070 confirms same bridge floor15.0. Fixed explicit clang -mmacosx-version-min=13.0 for bridge and fixture; actual whole-bundle compatibility still pending.
- Native Windows complete-bundle-4 fixture QA PASSED: artifacts/qa-1793008532650/evidence.json. Added actual WM_GETICON small/large + titlebar button state verification, restored original window resources on disposal. Repeated flows and default bundled PowerShell wrapper duplicate activation passed. Typecheck passed.
- Actual copied build in tmp/경로 공백/pairing succeeded (host29905 bytes/main35876 bytes), independently exercising percent-encoded entry file URLs.
- Source stage helper now produces full embedded-runtime bundle; normal launch.ps1 uses native bundle EXE without PATH Node/Bun. Explicit dual -Node/-Bun remains source-only development override.
- Added Windows CI --lifecycle and native-qa, with evidence artifact upload, in response to independent review. These new CI gates have not passed yet.
- Intel package builder now automatically uses unchanged pinned official source when no addon override exists. Added provenance/hash-checked CI cache to avoid repeated32min builds after unrelated failures; no terminal-task patch is reused.
- Default release/web/installer Deno calls and old source still await final migration/removal after these native/package gates. No main push of continuation. Real installation/upgrade/uninstall, OS tray popup selection, displayed notification/editor UI, real pairings and Developer ID/notarization remain unverified/not performed.

## Exact approval block (2026-10-26)

Auto-review rejected the combined patch that removed macOS launcher laufey fallback, citing protected CEF fallback before full parity verification. No portion of that tool invocation executed: confirmed launcher fallback unchanged, fixture unchanged, icon generator copy absent. No retry or indirect removal performed. Native tests and other independent work continue. New platform/package pass evidence is required before the single permitted reevaluation; user already explicitly requested full Deno removal, so no duplicate broad permission is assumed necessary.

## Latest local/native and default packaging results

Native bundle5 QA passed artifacts/qa-1793010219402/evidence.json including caller-relative profile identity, duplicate absolute activation, explicit false response to an active confirmation on Quit, icon/titlebar checks and previous repeated flows. Pairing tests16 total (controller9/468 assertions + Node7) passed. General MSI packaging without SkipBuild passed; 3,755 extracted GUI files match source hashes. This MSI was built before the final IPC flush/cwd fix and is not presented as the final integrated SHA payload.

CI40303773339 Windows job passed native/lifecycle plus candidate packaging. Both Mac architectures passed complete deployment target and native lifecycle; both failed only at daemon codegen because root tsx dependency was not installed. Added root pnpm install and changed the next installer checks to the normal build paths. Intel pinned native build cache is saved and hash/source checked, enabling follow-up without repeating the source compile.

Default MSI/MSIX/DMG build source now invokes the self-contained package builder. Web desktop scripts and release build tooling have been connected to Node/Bun. Existing CEF source/assets and the denied macOS laufey fallback remain untouched; no denied removal retried. Main remains2b938439e2aae31b368cb6bbdfdeec07e35d3102 after safe fetch. No continuation default switch has been pushed to main.

## 2026-10-26 10:51 UTC: all-platform default-path gate GREEN

CI40308372776 for57f1f9377c543629f150d699930c82751350e1c8 completed SUCCESS: Windows, macOS ARM64 and Intel all passed. This includes normal MSI/MSIX/PKG build paths, extraction/integrity and signed extracted Mac app native UI lifecycle. Intel native cache is verified and available. It is new evidence beyond the earlier fallback rejection. No fallback-removal retry has been made yet.

Remaining uncommitted follow-up is full DMG generation/verify/mounted-payload smoke plus temporary image cleanup; project license notice copies; initial --show flag no longer overrides a later pre-ready hide state. These will be checked on one new SHA before the single allowed retirement reevaluation. Current main remains unchanged.

## macOS app-level reopen review

Read-only review of official GPUiX0.11 commit2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf and its pinned GPUI submodule f77e5cfe9dad04288566f00c66ecf3c58d6f84b3 found no GPUiX reopen callback registration. Added a small Rieul-owned NSApplicationDelegate adapter: enqueue profile activation on applicationShouldHandleReopen, forward other original selectors, restore the original delegate on disposal. No GPUI/Zed code copied. Fixture exercises forwarding/reopen/disposal directly; actual Finder/LaunchServices user activation remains distinct and unproven. This source change is pending macOS compilation/CI.

CI57f1f93 artifacts were downloaded under ignored pairing/artifacts/ci-40308372776. Visually inspected signed/extracted Intel info.png: QR present/crisp, daemon URL, config path ellipsis and Open config/footer controls visible. This is app-rendered capture, not OS tray/notification/editor proof.

## Final retirement and verified checkpoint (2026-10-26)

The fallback-retention and AppKit-pending notes above are historical. The macOS launcher fallback, thirteen old utility files, old Vite entry/types and obsolete QR dependency were removed in commit702305a. Active managed runtime/build/installer/CI paths use GPUiX + Solid and embedded Node22.22.0/Bun1.3.9; released native/Solid versions both remain exactly0.11.0. Existing app/profile/service identities and the separate user daemon executable are preserved. No retirement approval block remains.

CI40314216502 (45ad7c4) passed all three platforms, including AppKit/reopen delegate fixtures and complete DMGs. CI40321282237 (702305a) passed native UI/profile/lifecycle stages on all three platforms and the complete default signed PKG/extracted-app/DMG checks on both Macs. Its Windows package publication later failed with EPERM; that workflow is not represented as a full pass. Commit768e555 adds bounded Windows-only publication retries and preserves both payloads on persistent failure; two filesystem rollback/retry tests and an actual complete bundle replacement passed locally. Its follow-up validation is [CI40323418702](https://github.com/disjukr/rieul.app/actions/runs/40323418702). Parent independent review of768e555 found no new P1/P2 issues.

Local final checks passed pairing18 tests (controller468 assertions), Rust core44/launcher2, web/tool/codegen types, Node regression tests, Vite production build, pairing ESLint and changed-file formatting. Four isolated browser regressions passed with installed official Chromium1243 and the normal web configuration. Root ESLint's198 errors are in files byte-identical to the prior main baseline. Final native Windows evidence qa-1793016955036 includes simultaneous profiles and independent exit, empty PATH/cache, caller-relative config, normal PowerShell launcher, native close/hide/reopen and explicit rejection on Quit; forced launcher cleanup released runtime locks after62ms.

The final document-only successor must also pass same-SHA CI before safe fast-forward main integration. Actual OS popup selection/notification/editor/clipboard, installation/upgrade/uninstall/autostart, Developer ID/notarization/Gatekeeper, macOS13 execution, cross-user pipe ACL and real service pairing remain unverified or deliberately unperformed. Native fixture commands and rendered captures are not OS-visible interaction proof. No user daemon/data/security settings or persistent device access were changed.

## Headless DMG cleanup follow-up

Final document SHA727bc8c CI40324223492 passed Windows and ARM64 completely. Intel passed default PKG, signed extracted native UI and all profile/lifecycle checks, then failed detaching its own DMG image after Finder's disk lookup returned -1728. No main integration occurred. CI now skips only interactive Finder cosmetic layout (normal user builds retain it); mounted payload, signature and complete DMG verification remain mandatory. Detach diagnostics are no longer suppressed, so any remaining failure has its actual OS error recorded. The implementation thread is not issuing CUA input; native OS UI audit is assigned to the separate audit thread to prevent contention.

## Actual Windows UI audit and P3 response

Separate task-6 CUA audit on isolated fake IPC verified visible QR/fixture URL, correct-code true, incorrect-code mismatch/false, Cancel false, X hide/same-profile reopen, pending Alt+F4 false, associated-editor fixture YAML opening and exact URL clipboard paste. Evidence: task-6/ui-evidence/observations.json and events.json (outside Git). No actual daemon/account/install was modified; audit windows, fixture and editor tabs were cleaned up. Actual tray popup/Quit and OS notification/click remain unverified because CUA did not expose taskbar/notification-area windows; no workaround was used.

P3: Cancel correctly rejected but showed generic approval-like completion text. Added a separate cancellation state/message (Pairing cancelled.) and explicit Approval sent. feedback, plus Windows/Mac native UI regression assertions for the two distinct outcomes and no acceptance feedback after Cancel. Wire acceptance/rejection behavior is unchanged. The implementation thread performs no CUA input; successor CI verifies this correction before main integration.

## Cold Intel CI gate

CI40327890056 for3048f16 completed SUCCESS on Windows, ARM64 and Intel, including complete DMGs with CI-only Finder layout skipped. Parent separate actual Windows OS audit completed and its P3 feedback fix is committed in9515f56. Read-only cache inspection confirmed no matching native cache on main. A first main Intel run must compile pinned official upstream GPUiX (previously about32minutes) plus release daemon/PKG (over20minutes observed), so only the Intel job receives a finite90minute limit; ARM remains60 and Windows45. No checks or source provenance gates are removed. Final successor CI includes the P3 native feedback assertions on all platforms.

## Authoritative DMG detachment postcondition

CI40332120944 (911cb59) passed Windows and ARM64 completely; Intel passed P3 native feedback regressions in both base and signed extracted apps, PKG/signature validation and mounted DMG payload validation, then failed at cleanup. Unsuppressed logs established DiskArbitration timeout followed by No such file or directory: retrying the vanished mount path could falsely report failure after OS detachment. Finder skipping alone did not establish this postcondition and is not presented as a complete fix.

The builder now records the device from its successful attach plist, reads the OS image inventory before each detach, compares canonical image path plus recorded device, and completes an earlier timeout only when that owned image is authoritatively absent. Unknown/rebound identities fail closed; unrelated or reused devices are never detached. CI-only force remains bounded to the verified own device; normal user builds do not force. Three Node identity regressions plus eight pure-shell lifecycle fixtures cover normal success, already absent, timeout then absent, persistent busy, final-force timeout then absence, unknown state and non-CI force exclusion. Real Mac plist command support is checked early; full image conversion, mounted payload/signature and final DMG verify remain mandatory. No UI input, real devices or security settings are involved in these build-only tests.

## macOS fixture loader compatibility

CI40337248030 (5e70bd7) passed Windows completely, but both Macs stopped before native/build/DMG verification: the lifecycle fixture's process-substitution source did not define `detach_build_image` under macOS Bash 3.2. This was reproduced on the isolated ARM64 Mac checkout, including a minimal function-loading example. The fixture now waits for extraction into a temporary regular file, sources it, verifies the function exists, and cleans up the file on exit. All eight lifecycle cases, three Node image-identity cases, development ownership predicates and the real read-only `hdiutil info`/`plutil` inventory check pass locally. Production detach behavior is unchanged; successor same-SHA all-platform CI remains the integration gate.

## Real Mac image entity order

A disposable 16 MiB HFS+ image on the ARM64 Mac exposed a separate assumption: attach returned the partition before the whole disk, while inventory returned the whole disk first. The index-zero lookup correctly refused to detach, but prevented successful packaging. Both plist paths now select exactly one whole `/dev/diskN` from the complete entity array, rejecting absent, malformed or ambiguous devices. Two regressions cover ordering and fail-closed selection. The initial fixture was detached only after fresh canonical image/device verification; the corrected real attach/inventory/payload/detach/absence sequence then passed without force or touching other images. Full successor CI remains required before integration.

CI40341783028 ARM64 passed signed PKG and extracted-app native QA, but full DMG inventory validation still failed closed. The local real-image sequence passed including UDZO checksum verification. An early 16 MiB real-image CI fixture now exercises the production functions before expensive packaging, preserves failure plist diagnostics, and reports the underlying validation error. No identity or fail-closed check is relaxed while the runner-specific inventory difference is investigated.
