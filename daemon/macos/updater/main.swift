import AppKit
import Darwin
import ServiceManagement

// Built but not packaged/activated by default. No credentials are generated.
@main struct ControllerMain {
  @MainActor static func main() {
    do {
      guard CommandLine.arguments.count == 2, let bundle = Bundle(url: productApp),
        Bundle.main.bundleURL.standardizedFileURL == productApp
      else {
        throw UpdateFailure.blocked("Run the bundled updater from the installed Rieul app")
      }
      try validatedUpdateConfiguration(bundle)
      let services = NativeServices(bundle: bundle)
      switch CommandLine.arguments[1] {
      case "run":
        let directory = FileManager.default.homeDirectoryForCurrentUser
          .appendingPathComponent("Library/Application Support/rieul-update", isDirectory: true)
        let journal = try FileJournal(directory: directory)
        let host = UpdateHost(bundle: bundle, journal: journal)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.delegate = host
        withExtendedLifetime(host) { application.run() }
      case "migrate-legacy", "rollback-legacy":
        let effects = NativeLegacyControl(bundle: bundle)
        _ = try effects.validateProtectedInstallation()
        let parent = URL(fileURLWithPath: "/Library/Application Support/rieul", isDirectory: true)
        var metadata = stat()
        guard parent.resolvingSymlinksInPath() == parent,
          lstat(parent.path, &metadata) == 0, metadata.st_uid == 0,
          metadata.st_mode & 0o022 == 0
        else {
          throw UpdateFailure.blocked(
            "Migration state needs the protected existing product data directory")
        }
        try requireProtectedDirectory(parent)
        let store = try DurableStore<MigrationRecord>(
          directory: parent.appendingPathComponent("update-migration", isDirectory: true))
        let migration = LegacyMigration(effects: effects, store: store)
        if CommandLine.arguments[1] == "migrate-legacy" {
          try migration.migrate()
        } else {
          try migration.rollback()
        }
      case "register-services":
        _ = try services.validateInstallation()
        if services.daemonState() == .notRegistered { try services.startDaemon() }
        guard services.daemonState() == .enabled else {
          throw UpdateFailure.blocked(
            "Approve Rieul's daemon in System Settings, then retry registration")
        }
        if services.agentState() == .notRegistered { try services.startAgent() }
        guard services.agentState() == .enabled else {
          throw UpdateFailure.blocked("GUI service requires approval")
        }
      default: throw UpdateFailure.blocked("Unknown updater operation")
      }
    } catch {
      fputs("Rieul update: \(error)\n", stderr)
      exit(1)
    }

  }
}
