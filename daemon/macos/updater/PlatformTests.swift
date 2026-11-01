import Foundation

// Read-only integration checks. Never instantiate a service controller or call
// register/unregister/launchctl mutations. Installed app is optional on CI.
@main struct PlatformTests {
  static func main() throws {
    do {
      _ = try verifySignature(URL(fileURLWithPath: "/usr/bin/true"), identifier: "app.rieul")
      fatalError("Platform binary accepted as Rieul")
    } catch { print("PASS Apple platform binary rejected as Rieul") }
    if FileManager.default.fileExists(atPath: productApp.path) {
      _ = try verifySignature(productApp, identifier: "app.rieul")
      _ = try verifySignature(
        productApp.appendingPathComponent(daemonRelative), identifier: "rieul-macos-system")
      print("PASS existing Developer ID app and embedded daemon signatures verified (read-only)")
      do {
        try protectedApp(productApp)
        print("PASS installed bundle protection policy")
      } catch {
        print("BLOCKED installed bundle protection audit: \(error). Installation unchanged.")
      }
      let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        .appendingPathComponent("rieul-signature-test-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
      defer { try? FileManager.default.removeItem(at: temporary) }
      var bytes = try Data(contentsOf: productApp.appendingPathComponent(daemonRelative))
      guard bytes.count > 4096 else { fatalError("Unexpected test executable") }
      bytes[4096] ^= 1
      let tampered = temporary.appendingPathComponent("tampered-daemon")
      try bytes.write(to: tampered)
      do {
        _ = try verifySignature(tampered, identifier: "rieul-macos-system")
        fatalError("Tampered signed daemon accepted")
      } catch { print("PASS tampered local copy of signed daemon rejected (never executed)") }
    }
  }
}
