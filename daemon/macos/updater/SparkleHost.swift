import AppKit
import ServiceManagement
import Sparkle

// Intercept the install choice before Sparkle stages executable content. Merely
// discovering or dismissing an update must not interrupt the daemon.
@MainActor
final class CoordinatedUserDriver: SPUStandardUserDriver {
  let coordinator: UpdateCoordinator
  init(bundle: Bundle, coordinator: UpdateCoordinator) {
    self.coordinator = coordinator
    super.init(hostBundle: bundle, delegate: nil)
  }
  override func showUpdateFound(
    with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    super.showUpdateFound(with: appcastItem, state: state) { choice in
      if choice == .install {
        do {
          if let transaction = try self.coordinator.store.load() {
            guard transaction.phase == .stopped,
              transaction.targetVersion == appcastItem.versionString,
              self.coordinator.services.daemonState() == .notRegistered
            else {
              throw UpdateFailure.blocked("Update services are not safely stopped")
            }
          } else {
            try self.coordinator.prepare(target: appcastItem.versionString)
          }
        } catch {
          // Skip cancels even a staged install; dismiss could leave
          // Sparkle configured to install automatically on quit.
          reply(.skip)
          try? self.coordinator.recover()
          let alert = NSAlert()
          alert.messageText = "Update could not safely start"
          alert.informativeText = String(describing: error)
          alert.runModal()
          return
        }
      }
      reply(choice)
    }
  }
}

// This host remains alive while its direct GUI child is running. Sparkle waits
// for THIS application process to exit and relaunches the normal bundle launcher.
@MainActor
final class UpdateHost: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
  let bundle: Bundle
  let coordinator: UpdateCoordinator
  let services: NativeServices
  private var updater: SPUUpdater?
  private var gui: Process?
  private var installing = false
  init(bundle: Bundle, journal: FileJournal) {
    self.bundle = bundle
    services = NativeServices(bundle: bundle)
    coordinator = UpdateCoordinator(services: services, store: journal)
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      _ = try services.validateInstallation()
      try coordinator.recover()
      guard services.daemonState() == .enabled, services.agentState() == .enabled else {
        throw UpdateFailure.blocked(
          "Enable Rieul services in System Settings before running the updater")
      }
      try services.verifyHealthy(version: services.validateInstallation())
      let child = Process()
      child.executableURL = bundle.bundleURL.appendingPathComponent("Contents/MacOS/rieul-gui")
      child.arguments = ["--config", "/Library/Application Support/rieul/rieul.yaml"]
      child.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
      try child.run()
      gui = child
      let driver = CoordinatedUserDriver(bundle: bundle, coordinator: coordinator)
      let updater = SPUUpdater(
        hostBundle: bundle, applicationBundle: bundle, userDriver: driver, delegate: self)
      self.updater = updater
      // Never silently opt the user into installation. Root protection is
      // retained, so Sparkle may ask for authorization for replacement.
      updater.automaticallyDownloadsUpdates = false
      try updater.start()
    } catch {
      report(error)
      NSApp.terminate(nil)
    }
  }
  func updater(
    _ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck
  ) throws {
    try UpdateConfiguration.validateArchive(
      version: item.versionString, type: item.installationType, delta: item.isDeltaUpdate,
      url: item.fileURL)
    let current = try services.validateInstallation()
    guard try newer(item.versionString, than: current) else {
      throw UpdateFailure.blocked("Not a newer stable release")
    }
    // The user-driver intercepts Install and commits the stop transaction
    // before replying to Sparkle. Background checks have no service effects.
  }
  func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { installing = true }
  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    installing = false
    do { try coordinator.recover() } catch { report(error) }
  }
  func updater(
    _ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?
  ) {
    if !installing { do { try coordinator.recover() } catch { report(error) } }
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // No process-name kill, no broad pkill. The GUI host receives SIGTERM
    // and disposes its own IPC/UI child using its existing shutdown path.
    guard let gui, gui.isRunning else { return .terminateNow }
    gui.terminationHandler = { _ in
      DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
    }
    gui.terminate()
    // Refuse a replacement if the child cannot close. A later user action
    // can retry; do not replace files underneath an unknown live GUI.
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
      if gui.isRunning { sender.reply(toApplicationShouldTerminate: false) }
    }
    return .terminateLater
  }
  private func report(_ error: Error) {
    fputs("Rieul update: \(error)\n", stderr)
    let alert = NSAlert()
    alert.messageText = "Rieul update needs attention"
    alert.informativeText = String(describing: error)
    alert.runModal()
  }
}

func validatedUpdateConfiguration(_ bundle: Bundle) throws {
  // The build pipeline must deliberately inject the public key and enable the
  // feature in the signed Info.plist. No environment/CLI override exists.
  try UpdateConfiguration.validate(bundle.infoDictionary ?? [:])
  guard #available(macOS 14, *) else {
    throw UpdateFailure.blocked(
      "macOS 13 must use the existing signed installer; spawn constraints require macOS 14")
  }
  // This release gate is intentionally not configurable. Only remove after
  // notarized old/new OS-matrix tests, daemon application health, and review.
  throw UpdateFailure.blocked(
    "Production activation is withheld pending signed lifecycle and compatibility validation")
}
