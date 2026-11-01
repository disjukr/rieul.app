import Foundation

// A separate one-time administrator transaction. No ownership change and no
// bundle copying. New service registration remains a user SMAppService action.
struct LegacySnapshot: Codable, Equatable {
  let label: String
  let plist: Data
  let domains: [String]
}
struct MigrationRecord: Codable, Equatable {
  let schema: Int
  let version: String
  let jobs: [LegacySnapshot]
  var removed: Bool
}
protocol MigrationStore {
  func load() throws -> MigrationRecord?
  func save(_ record: MigrationRecord) throws
  func clear() throws
}
extension DurableStore: MigrationStore where Record == MigrationRecord {}
protocol LegacyControl {
  func validateProtectedInstallation() throws -> String
  func snapshots() throws -> [LegacySnapshot]
  func stop(_ job: LegacySnapshot) throws
  func remove(_ job: LegacySnapshot) throws
  func absent(_ job: LegacySnapshot) throws -> Bool
  func restore(_ job: LegacySnapshot) throws
}
final class LegacyMigration {
  let effects: LegacyControl
  let store: MigrationStore
  init(effects: LegacyControl, store: MigrationStore) {
    self.effects = effects
    self.store = store
  }
  func migrate() throws {
    let version = try effects.validateProtectedInstallation()
    var record: MigrationRecord
    if let existing = try store.load() {
      guard existing.schema == 1, existing.version == version else {
        throw UpdateFailure.blocked("Migration journal does not match this protected app")
      }
      record = existing
    } else {
      record = MigrationRecord(
        schema: 1, version: version, jobs: try effects.snapshots(), removed: false)
      try store.save(record)
    }
    // Repeat every effect on recovery. Backups were committed before stops.
    for job in record.jobs { try effects.stop(job) }
    for job in record.jobs { try effects.remove(job) }
    for job in record.jobs {
      guard try effects.absent(job) else {
        throw UpdateFailure.blocked("Legacy job remains loaded or installed")
      }
    }
    record.removed = true
    try store.save(record)
    // Keep the root-owned backup until a reviewed migration is committed.
    // Pending user approval is an intentionally recoverable offline state.
  }
  func rollback() throws {
    guard let record = try store.load() else { return }
    guard record.schema == 1, try effects.validateProtectedInstallation() == record.version else {
      throw UpdateFailure.blocked("Refuse rollback across app/schema versions")
    }
    // Native adapter also refuses restoration while a v2 job is registered.
    for job in record.jobs { try effects.restore(job) }
    try store.clear()
  }
}
