import Darwin
import Foundation
import ServiceManagement

// Compiled for review, never invoked by the updater or this task. The only
// admissible destination is the existing fixed product installation.
final class NativeLegacyControl: LegacyControl {
  private let bundle: Bundle
  init(bundle: Bundle) { self.bundle = bundle }
  func validateProtectedInstallation() throws -> String {
    guard geteuid() == 0 else {
      throw UpdateFailure.blocked("Legacy migration needs explicit administrator authorization")
    }
    try protectedApp(bundle.bundleURL)
    _ = try verifySignature(bundle.bundleURL, identifier: "app.rieul")
    _ = try verifySignature(
      bundle.bundleURL.appendingPathComponent(daemonRelative), identifier: "rieul-macos-system")
    try validateServicePlist(bundle, daemon: true)
    try validateServicePlist(bundle, daemon: false)
    guard let version = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String else {
      throw UpdateFailure.blocked("Missing version")
    }
    _ = try versionParts(version)
    return version
  }
  private func path(_ label: String) throws -> URL {
    guard let job = legacyJobs.first(where: { $0.1 == label }) else {
      throw UpdateFailure.blocked("Unexpected legacy label")
    }
    let url = URL(fileURLWithPath: "/Library/\(job.0)/\(job.1).plist")
    guard
      url.deletingLastPathComponent().resolvingSymlinksInPath() == url.deletingLastPathComponent()
    else { throw UpdateFailure.blocked("Symlinked service directory") }
    try requireProtectedDirectory(url.deletingLastPathComponent())
    return url
  }
  private func validate(_ job: LegacySnapshot) throws {
    _ = try path(job.label)
    guard
      let plist = try PropertyListSerialization.propertyList(from: job.plist, format: nil)
        as? [String: Any],
      plist["Label"] as? String == job.label,
      let args = plist["ProgramArguments"] as? [String], let executable = args.first,
      plist["EnvironmentVariables"] == nil
        || plist["EnvironmentVariables"] as? [String: String] == ["RUST_LOG": "info"],
      plist["Program"] == nil
    else {
      throw UpdateFailure.blocked("Unexpected legacy plist; manual migration required")
    }
    let system = job.label == "app.rieul.daemon" || job.label == "app.rieul.system"
    let allowed =
      system
      ? [
        productApp.appendingPathComponent(daemonRelative).path,
        "/Library/Application Support/rieul/bin/rieul-macos-system",
      ] : [productApp.appendingPathComponent("Contents/MacOS/rieul-macos-launcher").path]
    let allowedArguments =
      system
      ? [
        [executable, "run"],
        [executable, "run", "--config", "/Library/Application Support/rieul/rieul.yaml"],
      ] : [[executable], [executable, "run"]]
    guard allowed.contains(executable), allowedArguments.contains(args),
      job.domains.allSatisfy({
        system ? $0 == "system" : $0.hasPrefix("gui/") && UInt32($0.dropFirst(4)) != nil
      })
    else {
      throw UpdateFailure.blocked("Unexpected legacy executable or service domain")
    }
    var metadata = stat()
    guard lstat(executable, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
      metadata.st_uid == 0, metadata.st_mode & 0o022 == 0,
      URL(fileURLWithPath: executable).resolvingSymlinksInPath().path == executable
    else {
      throw UpdateFailure.blocked("Legacy executable is not a protected regular file")
    }
    if executable.hasPrefix("/Library/") {
      try requireProtectedDirectory(URL(fileURLWithPath: executable).deletingLastPathComponent())
    }
    // Backups can never be used to restore a different executable identity.
    _ = try verifySignature(
      URL(fileURLWithPath: executable), identifier: system ? "rieul-macos-system" : "app.rieul")
  }
  func snapshots() throws -> [LegacySnapshot] {
    _ = try validateProtectedInstallation()
    let (status, listing) = try command("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"])
    guard status == 0 else { throw UpdateFailure.blocked("Cannot enumerate user service domains") }
    let userDomains = Set(
      listing.split(separator: "\n").compactMap { line -> String? in
        guard let last = line.split(whereSeparator: { $0.isWhitespace }).last,
          let uid = UInt32(last), uid >= 500
        else { return nil }
        return "gui/\(uid)"
      })
    var result: [LegacySnapshot] = []
    for (directory, label) in legacyJobs {
      let url = try path(label)
      var metadata = stat()
      let domains = directory == "LaunchDaemons" ? ["system"] : Array(userDomains).sorted()
      let live = try domains.filter {
        try jobLoaded("\($0)/\(label)")
      }
      if lstat(url.path, &metadata) != 0 {
        guard errno == ENOENT, live.isEmpty else {
          throw UpdateFailure.blocked("Loaded legacy job has no restorable plist")
        }
        continue
      }
      guard metadata.st_uid == 0, metadata.st_mode & S_IFMT == S_IFREG,
        metadata.st_mode & 0o022 == 0, metadata.st_nlink == 1
      else {
        throw UpdateFailure.blocked("Legacy plist is not a protected regular file")
      }
      let snapshot = LegacySnapshot(label: label, plist: try Data(contentsOf: url), domains: live)
      try validate(snapshot)
      result.append(snapshot)
    }
    return result
  }
  func stop(_ job: LegacySnapshot) throws {
    _ = try validateProtectedInstallation()
    try validate(job)
    for domain in job.domains {
      if try jobLoaded("\(domain)/\(job.label)") {
        guard try command("/bin/launchctl", ["bootout", "\(domain)/\(job.label)"]).0 == 0 else {
          throw UpdateFailure.blocked("Unable to stop legacy service")
        }
      }
    }
  }
  func remove(_ job: LegacySnapshot) throws {
    let url = try path(job.label)
    // The directory is root-controlled; never follow a replaced plist.
    var metadata = stat()
    if lstat(url.path, &metadata) != 0 {
      guard errno == ENOENT else { throw UpdateFailure.blocked("Cannot inspect legacy plist") }
      return
    }
    guard metadata.st_mode & S_IFMT == S_IFREG, metadata.st_uid == 0,
      try Data(contentsOf: url) == job.plist
    else { throw UpdateFailure.blocked("Legacy plist changed during migration") }
    try FileManager.default.removeItem(at: url)
  }
  func absent(_ job: LegacySnapshot) throws -> Bool {
    var metadata = stat()
    if lstat(try path(job.label).path, &metadata) == 0 { return false }
    guard errno == ENOENT else { throw UpdateFailure.blocked("Cannot verify legacy removal") }
    for domain in job.domains {
      let (status, _) = try command("/bin/launchctl", ["print", "\(domain)/\(job.label)"])
      guard status == 113 else { return false }  // ESRCH: no such service
    }
    return true
  }
  func restore(_ job: LegacySnapshot) throws {
    _ = try validateProtectedInstallation()
    try validate(job)
    guard SMAppService.daemon(plistName: "\(daemonLabel).plist").status == .notRegistered,
      SMAppService.agent(plistName: "\(agentLabel).plist").status == .notRegistered
    else {
      throw UpdateFailure.blocked("Unregister v2 services before restoring a legacy service")
    }
    let url = try path(job.label)
    var metadata = stat()
    if lstat(url.path, &metadata) == 0 {
      guard metadata.st_mode & S_IFMT == S_IFREG, metadata.st_uid == 0,
        try Data(contentsOf: url) == job.plist
      else { throw UpdateFailure.blocked("Refuse to overwrite changed legacy plist") }
    } else {
      guard errno == ENOENT else { throw UpdateFailure.blocked("Cannot inspect recovery target") }
      let parentFD = open(
        url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard parentFD >= 0 else {
        throw UpdateFailure.blocked("Cannot open protected plist directory")
      }
      defer { close(parentFD) }
      let temporary = ".rieul-restore-\(UUID().uuidString).tmp"
      let fd = openat(
        parentFD, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard fd >= 0 else { throw UpdateFailure.blocked("Cannot stage restored plist") }
      defer {
        close(fd)
        unlinkat(parentFD, temporary, 0)
      }
      guard job.plist.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) == $0.count }),
        fchmod(fd, 0o644) == 0, fsync(fd) == 0,
        renameatx_np(parentFD, temporary, parentFD, url.lastPathComponent, UInt32(RENAME_EXCL))
          == 0,
        fsync(parentFD) == 0
      else {
        throw UpdateFailure.blocked("Cannot atomically restore plist")
      }
    }
    for domain in job.domains {
      if try !jobLoaded("\(domain)/\(job.label)") {
        guard try command("/bin/launchctl", ["bootstrap", domain, url.path]).0 == 0 else {
          throw UpdateFailure.blocked("Legacy service restore failed")
        }
      }
    }
  }
}
