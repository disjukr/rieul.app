import Foundation

// No networking, privileged commands, or dynamic paths in the coordinator.
// Adapters implement effects; tests inject an in-memory service and crashable store.
enum UpdateFailure: Error, CustomStringConvertible {
  case blocked(String)
  var description: String {
    switch self {
    case .blocked(let reason): return reason
    }
  }
}

enum ServiceState { case enabled, notRegistered, approvalRequired, unavailable }
enum Phase: String, Codable { case preparing, stopped, awaitingApproval, healthy }
struct Transaction: Codable, Equatable {
  let schema: Int
  let oldVersion: String
  let targetVersion: String
  var phase: Phase
}
protocol TransactionStore {
  func load() throws -> Transaction?
  func save(_ transaction: Transaction) throws
  func clear() throws
}
protocol ServiceControl {
  // This must re-check the live bundle and legacy registration on every call.
  func validateInstallation() throws -> String
  func daemonState() -> ServiceState
  func agentState() -> ServiceState
  func stopDaemon() throws
  func startDaemon() throws
  func startAgent() throws
  func verifyHealthy(version: String) throws
}

func versionParts(_ version: String) throws -> [Int] {
  let pieces = version.split(separator: ".", omittingEmptySubsequences: false)
  guard pieces.count == 3 else {
    throw UpdateFailure.blocked("Only stable x.y.z releases are accepted")
  }
  return try pieces.map {
    guard !$0.isEmpty, $0.allSatisfy({ $0.isASCII && $0.isNumber }),
      $0.count == 1 || $0.first != "0", let value = Int($0), value <= 65535
    else {
      throw UpdateFailure.blocked("Invalid release version")
    }
    return value
  }
}
func newer(_ target: String, than current: String) throws -> Bool {
  try versionParts(current).lexicographicallyPrecedes(versionParts(target))
}

final class UpdateCoordinator {
  let services: ServiceControl
  let store: TransactionStore
  init(services: ServiceControl, store: TransactionStore) {
    self.services = services
    self.store = store
  }

  func prepare(target: String) throws {
    guard try store.load() == nil else {
      throw UpdateFailure.blocked("An update is already pending; recover it first")
    }
    let old = try services.validateInstallation()
    guard try newer(target, than: old) else {
      throw UpdateFailure.blocked("Downgrades and same-version updates are refused")
    }
    guard services.daemonState() == .enabled, services.agentState() == .enabled else {
      throw UpdateFailure.blocked("Both services must be approved before updating")
    }
    // Keep the GUI agent registered (KeepAlive=false). Unregistering our
    // own job would kill this coordinator. Sparkle owns GUI termination.
    // Write intent before the first external effect. A crash at either stop
    // is recoverable because the daemon stop operation is idempotent.
    var transaction = Transaction(
      schema: 1, oldVersion: old, targetVersion: target, phase: .preparing)
    try store.save(transaction)
    try services.stopDaemon()
    guard services.daemonState() == .notRegistered else {
      throw UpdateFailure.blocked("Services did not stop; installation is blocked")
    }
    transaction.phase = .stopped
    try store.save(transaction)
  }

  // Called after restart or an aborted download. Never restores a legacy job,
  // changes ownership, or trusts a journal's paths/commands/signing identity.
  func recover() throws {
    guard var transaction = try store.load() else { return }
    guard transaction.schema == 1 else {
      throw UpdateFailure.blocked("Unsupported recovery journal")
    }
    _ = try versionParts(transaction.oldVersion)
    guard try newer(transaction.targetVersion, than: transaction.oldVersion) else {
      throw UpdateFailure.blocked("Invalid recovery version transition")
    }
    let installed = try services.validateInstallation()
    guard installed == transaction.oldVersion || installed == transaction.targetVersion else {
      throw UpdateFailure.blocked("Installed version does not match the interrupted transaction")
    }
    // Register daemon before agent; pending approval is never success.
    if services.daemonState() == .notRegistered { try services.startDaemon() }
    guard services.daemonState() == .enabled else {
      transaction.phase = .awaitingApproval
      try store.save(transaction)
      throw UpdateFailure.blocked("Daemon approval is required in System Settings")
    }
    if services.agentState() == .notRegistered { try services.startAgent() }
    guard services.agentState() == .enabled else {
      transaction.phase = .awaitingApproval
      try store.save(transaction)
      throw UpdateFailure.blocked("GUI service approval is required")
    }
    // Failure retains the journal. No old binary is run against a newer DB.
    // A failed new release needs an explicitly compatible repair release.
    try services.verifyHealthy(version: installed)
    transaction.phase = .healthy
    try store.save(transaction)
    try store.clear()
  }
}
