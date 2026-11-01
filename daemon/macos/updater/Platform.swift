import Darwin
import Foundation
import Security
import ServiceManagement

let productApp = URL(fileURLWithPath: "/Applications/Rieul.app", isDirectory: true)
let daemonRelative = "Contents/Library/LaunchServices/rieul-macos-system"
let daemonLabel = "app.rieul.daemon.v2"
let agentLabel = "app.rieul.gui.v2"
let teamID = "D379GLRLPV"

func requirement(_ identifier: String) throws -> SecRequirement {
  let expression =
    "anchor apple generic and identifier \"\(identifier)\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\""
  var result: SecRequirement?
  guard SecRequirementCreateWithString(expression as CFString, [], &result) == errSecSuccess,
    let result
  else {
    throw UpdateFailure.blocked("Cannot construct fixed product signing requirement")
  }
  return result
}
func verifySignature(_ url: URL, identifier: String) throws -> SecStaticCode {
  var code: SecStaticCode?
  guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else {
    throw UpdateFailure.blocked("Cannot read code signature")
  }
  let flags = SecCSFlags(
    rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
  guard SecStaticCodeCheckValidity(code, flags, try requirement(identifier)) == errSecSuccess else {
    throw UpdateFailure.blocked("Product code signature does not match the expected identity")
  }
  return code
}
func requireProtectedDirectory(_ directory: URL) throws {
  var current = directory
  while true {
    var metadata = stat()
    guard current.resolvingSymlinksInPath().path == current.path,
      lstat(current.path, &metadata) == 0, metadata.st_uid == 0,
      metadata.st_mode & S_IFMT == S_IFDIR, metadata.st_mode & 0o022 == 0
    else { throw UpdateFailure.blocked("Privileged state directory is not protected") }
    if let acl = acl_get_file(current.path, ACL_TYPE_EXTENDED) {
      defer { acl_free(UnsafeMutableRawPointer(acl)) }
      var entry: acl_entry_t?
      guard acl_valid(acl) == 0,
        acl_get_entry(acl, ACL_FIRST_ENTRY.rawValue, &entry) == -1, errno == EINVAL
      else { throw UpdateFailure.blocked("Privileged state directory has an unreviewed ACL") }
    } else if errno != ENOENT {
      throw UpdateFailure.blocked("Cannot inspect privileged directory ACL")
    }
    if current.path == "/" { break }
    current.deleteLastPathComponent()
  }
}

func protectedApp(_ app: URL) throws {
  // This policy intentionally rejects user-owned bundles on ALL OS versions.
  // SpawnConstraint is defense in depth, not a reason to weaken ownership.
  guard app.path == productApp.path, app.resolvingSymlinksInPath().path == app.path else {
    throw UpdateFailure.blocked("Unexpected or symlinked application path")
  }
  guard let enumeration = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)
  else {
    throw UpdateFailure.blocked("Cannot inspect application protection")
  }
  for url in [app] + enumeration.compactMap({ $0 as? URL }) {
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0, metadata.st_uid == 0 else {
      throw UpdateFailure.blocked("App resources must remain root-owned")
    }
    if metadata.st_mode & S_IFMT == S_IFLNK {
      guard url.resolvingSymlinksInPath().path.hasPrefix(app.path + "/") else {
        throw UpdateFailure.blocked("App contains an escaping symlink")
      }
      continue
    }
    guard metadata.st_mode & 0o022 == 0 else {
      throw UpdateFailure.blocked("App contains writable resources")
    }
    if let acl = acl_get_file(url.path, ACL_TYPE_EXTENDED) {
      defer { acl_free(UnsafeMutableRawPointer(acl)) }
      var entry: acl_entry_t?
      // Conservatively reject extended ACLs, including harmless ones.
      guard acl_valid(acl) == 0, acl_get_entry(acl, ACL_FIRST_ENTRY.rawValue, &entry) == -1,
        errno == EINVAL
      else {
        throw UpdateFailure.blocked("App has an unreviewed ACL")
      }
    } else if errno != ENOENT {
      throw UpdateFailure.blocked("Cannot inspect app ACL")
    }
    // macOS returns ENOENT for an existing file with no extended ACL.
  }
}

@discardableResult
func command(_ executable: String, _ arguments: [String]) throws -> (Int32, String) {
  let process = Process()
  let output = Pipe()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  process.standardOutput = output
  process.standardError = output
  // No inherited DYLD*, configuration, or PATH overrides.
  process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"]
  try process.run()
  let data = output.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}

func jobLoaded(_ target: String) throws -> Bool {
  let (status, _) = try command("/bin/launchctl", ["print", target])
  if status == 0 { return true }
  if status == 113 { return false }
  throw UpdateFailure.blocked("Cannot determine launchd job state")
}

let legacyJobs = [
  ("LaunchDaemons", "app.rieul.daemon"), ("LaunchDaemons", "app.rieul.system"),
  ("LaunchAgents", "app.rieul.gui"), ("LaunchAgents", "app.rieul.user"),
]
func legacyRegistrationPresent() throws -> Bool {
  for (directory, label) in legacyJobs {
    var metadata = stat()
    if lstat("/Library/\(directory)/\(label).plist", &metadata) == 0 { return true }
    guard errno == ENOENT else { throw UpdateFailure.blocked("Cannot inspect legacy registration") }
    if directory == "LaunchDaemons",
      try jobLoaded("system/\(label)")
    {
      return true
    }
  }
  return false
}

func validateServicePlist(_ bundle: Bundle, daemon: Bool) throws {
  let label = daemon ? daemonLabel : agentLabel
  let directory = daemon ? "LaunchDaemons" : "LaunchAgents"
  let url = bundle.bundleURL.appendingPathComponent("Contents/Library/\(directory)/\(label).plist")
  let data = try Data(contentsOf: url)
  guard
    let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
      as? [String: Any],
    plist["Label"] as? String == label,
    plist["BundleProgram"] as? String
      == (daemon ? daemonRelative : "Contents/MacOS/rieul-macos-launcher"),
    plist["Program"] == nil, plist["EnvironmentVariables"] == nil,
    let constraint = plist["SpawnConstraint"] as? [String: Any],
    constraint["team-identifier"] as? String == teamID,
    constraint["signing-identifier"] as? String == (daemon ? "rieul-macos-system" : "app.rieul"),
    constraint["validation-category"] as? Int == 6
  else {
    throw UpdateFailure.blocked(
      "Service plist lacks the expected immutable executable and spawn constraint")
  }
  let allowed: Set<String> = [
    "Label", "BundleProgram", "ProgramArguments", "RunAtLoad", "KeepAlive", "SpawnConstraint",
    "LimitLoadToSessionType",
  ]
  let args =
    daemon
    ? ["rieul-macos-system", "run", "--config", "/Library/Application Support/rieul/rieul.yaml"]
    : ["rieul-macos-launcher", "run"]
  guard Set(plist.keys).isSubset(of: allowed), plist["ProgramArguments"] as? [String] == args,
    plist["RunAtLoad"] as? Bool == true, plist["KeepAlive"] as? Bool == daemon
  else {
    throw UpdateFailure.blocked("Unexpected service arguments or restart policy")
  }
}

final class NativeServices: ServiceControl {
  let bundle: Bundle
  init(bundle: Bundle) { self.bundle = bundle }
  private var daemon: SMAppService { .daemon(plistName: "\(daemonLabel).plist") }
  private var agent: SMAppService { .agent(plistName: "\(agentLabel).plist") }
  func validateInstallation() throws -> String {
    guard geteuid() != 0 else {
      throw UpdateFailure.blocked("The update controller must run as the logged-in user")
    }
    try protectedApp(bundle.bundleURL)
    _ = try verifySignature(bundle.bundleURL, identifier: "app.rieul")
    _ = try verifySignature(
      bundle.bundleURL.appendingPathComponent(daemonRelative), identifier: "rieul-macos-system")
    guard try !legacyRegistrationPresent() else {
      throw UpdateFailure.blocked("Complete the one-time legacy service migration first")
    }
    try validateServicePlist(bundle, daemon: true)
    try validateServicePlist(bundle, daemon: false)
    guard let version = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String else {
      throw UpdateFailure.blocked("Missing installed version")
    }
    _ = try versionParts(version)
    return version
  }
  private func state(_ service: SMAppService) -> ServiceState {
    switch service.status {
    case .enabled: return .enabled
    case .notRegistered: return .notRegistered
    case .requiresApproval: return .approvalRequired
    default: return .unavailable
    }
  }
  func daemonState() -> ServiceState { state(daemon) }
  func agentState() -> ServiceState { state(agent) }
  func stopAgent() throws { if agent.status != .notRegistered { try agent.unregister() } }
  func stopDaemon() throws {
    if daemon.status != .notRegistered { try daemon.unregister() }
    guard try command("/bin/launchctl", ["print", "system/\(daemonLabel)"]).0 == 113 else {
      throw UpdateFailure.blocked("Daemon is still loaded or its state is unknown")
    }
  }
  func startDaemon() throws {
    _ = try validateInstallation()
    try daemon.register()
  }
  func startAgent() throws {
    _ = try validateInstallation()
    try agent.register()
  }
  func verifyHealthy(version: String) throws {
    guard try validateInstallation() == version else {
      throw UpdateFailure.blocked("Version changed during recovery")
    }
    let (status, output) = try command("/bin/launchctl", ["print", "system/\(daemonLabel)"])
    guard status == 0,
      let pid = output.split(separator: "\n").compactMap({ line -> Int32? in
        let text = line.trimmingCharacters(in: .whitespaces)
        return text.hasPrefix("pid = ") ? Int32(text.dropFirst(6)) : nil
      }).first
    else {
      throw UpdateFailure.blocked("Daemon has not started; retry recovery after launchd starts it")
    }
    var running: SecCode?
    guard
      SecCodeCopyGuestWithAttributes(
        nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &running) == errSecSuccess,
      let running,
      SecCodeCheckValidity(running, [], try requirement("rieul-macos-system")) == errSecSuccess
    else {
      throw UpdateFailure.blocked("Running daemon identity mismatch")
    }
    var runningInfo: CFDictionary?
    var installedInfo: CFDictionary?
    let installed = try verifySignature(
      bundle.bundleURL.appendingPathComponent(daemonRelative), identifier: "rieul-macos-system")
    var runningStatic: SecStaticCode?
    guard SecCodeCopyStaticCode(running, [], &runningStatic) == errSecSuccess, let runningStatic,
      SecCodeCopySigningInformation(
        runningStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &runningInfo)
        == errSecSuccess,
      SecCodeCopySigningInformation(
        installed, SecCSFlags(rawValue: kSecCSSigningInformation), &installedInfo) == errSecSuccess,
      let liveHash = (runningInfo as? [String: Any])?[kSecCodeInfoUnique as String] as? Data,
      let diskHash = (installedInfo as? [String: Any])?[kSecCodeInfoUnique as String] as? Data,
      liveHash == diskHash
    else { throw UpdateFailure.blocked("Running daemon is not the installed build") }
    // This proves launch identity/version, not transport/database health.
    // Production activation remains gated on an application health probe.
  }
}
