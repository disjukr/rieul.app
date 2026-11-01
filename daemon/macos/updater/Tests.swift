import Darwin
import Foundation

struct Crash: Error {}
final class Faults {
  var step = 0
  var failAt: Int?
  var events: [String] = []
  func after(_ event: String) throws {
    events.append(event)
    step += 1
    if step == failAt { throw Crash() }
  }
  func reset() {
    failAt = nil
    step = 0
    events = []
  }
}
final class MemoryJournal: TransactionStore {
  var record: Transaction?
  let faults: Faults
  init(_ faults: Faults) { self.faults = faults }
  func load() throws -> Transaction? { record }
  func save(_ record: Transaction) throws {
    self.record = record
    try faults.after("save:\(record.phase.rawValue)")
  }
  func clear() throws {
    record = nil
    try faults.after("clear")
  }
}
final class FakeServices: ServiceControl {
  var version = "1.2.3"
  var trusted = true
  var daemon: ServiceState = .enabled
  var agent: ServiceState = .enabled
  var approval = true
  var healthy = true
  var stopped = true
  let faults: Faults
  init(_ faults: Faults) { self.faults = faults }
  func validateInstallation() throws -> String {
    guard trusted else { throw UpdateFailure.blocked("Wrong identity or writable bundle") }
    return version
  }
  func daemonState() -> ServiceState { daemon }
  func agentState() -> ServiceState { agent }
  func stopDaemon() throws {
    if stopped { daemon = .notRegistered }
    try faults.after("stop-daemon")
  }
  func startDaemon() throws {
    daemon = approval ? .enabled : .approvalRequired
    try faults.after("start-daemon")
  }
  func startAgent() throws {
    agent = .enabled
    try faults.after("start-agent")
  }
  func verifyHealthy(version: String) throws {
    guard healthy && self.version == version else {
      throw UpdateFailure.blocked("Unhealthy daemon")
    }
    try faults.after("health")
  }
}
final class MemoryMigration: MigrationStore {
  var record: MigrationRecord?
  let faults: Faults
  init(_ faults: Faults) { self.faults = faults }
  func load() throws -> MigrationRecord? { record }
  func save(_ record: MigrationRecord) throws {
    self.record = record
    try faults.after("migration-save")
  }
  func clear() throws {
    record = nil
    try faults.after("migration-clear")
  }
}
final class FakeLegacy: LegacyControl {
  var version = "1.2.3"
  var protected = true
  let jobs = [
    LegacySnapshot(label: "app.rieul.daemon", plist: Data("daemon".utf8), domains: ["system"]),
    LegacySnapshot(label: "app.rieul.gui", plist: Data("gui".utf8), domains: ["gui/501"]),
  ]
  var loaded = Set(["app.rieul.daemon", "app.rieul.gui"])
  var files = Set(["app.rieul.daemon", "app.rieul.gui"])
  let faults: Faults
  init(_ faults: Faults) { self.faults = faults }
  func validateProtectedInstallation() throws -> String {
    guard protected else { throw UpdateFailure.blocked("Unprotected app") }
    return version
  }
  func snapshots() throws -> [LegacySnapshot] { jobs }
  func stop(_ job: LegacySnapshot) throws {
    loaded.remove(job.label)
    try faults.after("stop:\(job.label)")
  }
  func remove(_ job: LegacySnapshot) throws {
    precondition(!loaded.contains(job.label), "Must stop before removing plist")
    files.remove(job.label)
    try faults.after("remove:\(job.label)")
  }
  func absent(_ job: LegacySnapshot) throws -> Bool {
    !loaded.contains(job.label) && !files.contains(job.label)
  }
  func restore(_ job: LegacySnapshot) throws {
    files.insert(job.label)
    loaded.insert(job.label)
    try faults.after("restore:\(job.label)")
  }
}

@main struct Tests {
  static var count = 0
  static func check(_ value: Bool) { precondition(value) }
  static func test(_ name: String, _ body: () throws -> Void) throws {
    try body()
    count += 1
    print("PASS \(name)")
  }
  static func rejects(_ body: () throws -> Void) {
    do {
      try body()
      fatalError("Expected rejection")
    } catch {}
  }
  static func fixture(_ body: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("rieul-update-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    try body(directory)
  }
  static func main() throws {
    try test("version policy rejects prerelease, malformed, overflow and downgrade") {
      for version in [
        "1", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.-1", "1.2.65536", "١.2.3", "1.2.3.4",
      ] { rejects { _ = try versionParts(version) } }
      check(try newer("1.2.4", than: "1.2.3"))
      check(try !newer("1.2.2", than: "1.2.3"))
    }
    try test("signed-feed configuration requires explicit public-key injection") {
      var metadata: [String: Any] = [
        "RieulUpdaterEnabled": true, "SUVerifyUpdateBeforeExtraction": true,
        "SURequireSignedFeed": true, "SUAllowsAutomaticUpdates": false,
        "SUPublicEDKey": Data(repeating: 0, count: 32).base64EncodedString(),
        "SUFeedURL": UpdateConfiguration.feed,
      ]
      try UpdateConfiguration.validate(metadata)
      for key in Array(metadata.keys) {
        var missing = metadata
        missing.removeValue(forKey: key)
        rejects { try UpdateConfiguration.validate(missing) }
      }
      metadata["SUAllowsAutomaticUpdates"] = true
      rejects { try UpdateConfiguration.validate(metadata) }
    }
    try test("archive policy rejects packages, deltas, wrong release and untrusted URLs") {
      let expected = URL(
        string:
          "https://github.com/disjukr/rieul.app/releases/download/desktop-1.2.4/rieul-macos-desktop.zip"
      )!
      try UpdateConfiguration.validateArchive(
        version: "1.2.4", type: "application", delta: false, url: expected)
      rejects {
        try UpdateConfiguration.validateArchive(
          version: "1.2.4", type: "package", delta: false, url: expected)
      }
      rejects {
        try UpdateConfiguration.validateArchive(
          version: "1.2.4", type: "application", delta: true, url: expected)
      }
      for url in [
        "http://github.com/disjukr/rieul.app/releases/download/desktop-1.2.4/rieul-macos-desktop.zip",
        expected.absoluteString + "?url=evil", "https://evil.example/update.zip",
        "file:///tmp/update.zip",
        expected.absoluteString.replacingOccurrences(of: "desktop-1.2.4", with: "desktop-1.2.3"),
      ] {
        rejects {
          try UpdateConfiguration.validateArchive(
            version: "1.2.4", type: "application", delta: false, url: URL(string: url))
        }
      }
    }
    for crash in 1...3 {
      try test("recover preparation interruption after effect \(crash)") {
        let faults = Faults()
        // Share fault counter across both storage and service effects.
        let journal = MemoryJournal(faults)
        let services = FakeServices(faults)
        let c = UpdateCoordinator(services: services, store: journal)
        faults.failAt = crash
        rejects { try c.prepare(target: "1.2.4") }
        check(journal.record != nil)
        faults.reset()
        try c.recover()
        check(journal.record == nil && services.daemon == .enabled)
      }
    }
    try test("journal precedes daemon stop; GUI job is not unregistered") {
      let f = Faults()
      let j = MemoryJournal(f)
      let services = FakeServices(f)
      try UpdateCoordinator(services: services, store: j).prepare(target: "1.2.4")
      check(f.events == ["save:preparing", "stop-daemon", "save:stopped"])
    }
    try test("failed stop prevents prepared state") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      s.stopped = false
      rejects { try UpdateCoordinator(services: s, store: j).prepare(target: "1.2.4") }
      check(j.record?.phase == .preparing)
    }
    try test("unsigned/wrong identity candidate cannot change service state") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      s.trusted = false
      rejects { try UpdateCoordinator(services: s, store: j).prepare(target: "1.2.4") }
      check(j.record == nil && s.daemon == .enabled)
    }
    try test("duplicate update fails without additional service effects") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      let c = UpdateCoordinator(services: s, store: j)
      try c.prepare(target: "1.2.4")
      f.reset()
      rejects { try c.prepare(target: "1.2.5") }
      check(j.record?.targetVersion == "1.2.4" && f.events.isEmpty)
    }
    try test("new bundle is verified before daemon registration") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      let c = UpdateCoordinator(services: s, store: j)
      try c.prepare(target: "1.2.4")
      s.version = "1.2.4"
      s.trusted = false
      rejects { try c.recover() }
      check(s.daemon == .notRegistered && j.record != nil)
      s.trusted = true
      try c.recover()
      check(j.record == nil)
    }
    try test("unknown installed version is not automatically rolled back") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      let c = UpdateCoordinator(services: s, store: j)
      try c.prepare(target: "1.2.4")
      s.version = "1.2.5"
      rejects { try c.recover() }
      check(s.daemon == .notRegistered && j.record != nil)
    }
    try test("pending approval persists and resumes after explicit approval") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      let c = UpdateCoordinator(services: s, store: j)
      try c.prepare(target: "1.2.4")
      s.approval = false
      rejects { try c.recover() }
      check(j.record?.phase == .awaitingApproval)
      s.daemon = .enabled
      try c.recover()
      check(j.record == nil)
    }
    try test("new daemon health failure preserves recovery record") {
      let f = Faults()
      let j = MemoryJournal(f)
      let s = FakeServices(f)
      let c = UpdateCoordinator(services: s, store: j)
      try c.prepare(target: "1.2.4")
      s.version = "1.2.4"
      s.healthy = false
      rejects { try c.recover() }
      check(j.record != nil && s.version == "1.2.4")
    }
    for crash in 1...6 {
      try test("legacy migration recovers interruption after effect \(crash)") {
        let f = Faults()
        let store = MemoryMigration(f)
        let effects = FakeLegacy(f)
        let migration = LegacyMigration(effects: effects, store: store)
        f.failAt = crash
        rejects { try migration.migrate() }
        check(store.record != nil)
        f.reset()
        try migration.migrate()
        check(effects.loaded.isEmpty && effects.files.isEmpty && store.record?.removed == true)
        try migration.rollback()
        check(effects.loaded.count == 2 && effects.files.count == 2 && store.record == nil)
      }
    }
    try test("migration rejects unprotected installation before taking action") {
      let f = Faults()
      let store = MemoryMigration(f)
      let effects = FakeLegacy(f)
      effects.protected = false
      rejects { try LegacyMigration(effects: effects, store: store).migrate() }
      check(store.record == nil && effects.loaded.count == 2)
    }
    try test("legacy rollback refuses a different app/schema version") {
      let f = Faults()
      let store = MemoryMigration(f)
      let effects = FakeLegacy(f)
      let migration = LegacyMigration(effects: effects, store: store)
      try migration.migrate()
      effects.version = "1.3.0"
      rejects { try migration.rollback() }
      check(effects.loaded.isEmpty && store.record != nil)
    }
    try test("durable journal round-trip and concurrent updater exclusion") {
      try fixture { dir in
        let store = try FileJournal(directory: dir)
        rejects { _ = try FileJournal(directory: dir) }
        let record = Transaction(
          schema: 1, oldVersion: "1.2.3", targetVersion: "1.2.4", phase: .stopped)
        try store.save(record)
        check(try store.load() == record)
        try store.clear()
        check(try store.load() == nil)
      }
    }
    try test("symlinked journal is rejected without modifying its target") {
      try fixture { dir in
        let store = try FileJournal(directory: dir)
        let target = dir.appendingPathComponent("valuable")
        try Data("preserve me".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(
          at: dir.appendingPathComponent("transaction.json"), withDestinationURL: target)
        rejects { _ = try store.load() }
        check(try String(contentsOf: target, encoding: .utf8) == "preserve me")
      }
    }
    try test("malformed journal is rejected") {
      try fixture { dir in
        let store = try FileJournal(directory: dir)
        try Data("not JSON".utf8).write(to: dir.appendingPathComponent("transaction.json"))
        rejects { _ = try store.load() }
      }
    }
    try test("world-writable recovery directory is rejected") {
      try fixture { dir in
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: dir.path)
        rejects { _ = try FileJournal(directory: dir) }
      }
    }
    print(
      "\(count) fixture tests passed; no live services, signing keys, or installed apps changed")
  }
}
