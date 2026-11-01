import Foundation

enum UpdateConfiguration {
  static let feed = "https://github.com/disjukr/rieul.app/releases/latest/download/appcast.xml"
  static func validate(_ metadata: [String: Any]) throws {
    guard metadata["RieulUpdaterEnabled"] as? Bool == true,
      metadata["SUVerifyUpdateBeforeExtraction"] as? Bool == true,
      metadata["SURequireSignedFeed"] as? Bool == true,
      metadata["SUAllowsAutomaticUpdates"] as? Bool == false,
      let key = metadata["SUPublicEDKey"] as? String,
      let bytes = Data(base64Encoded: key), bytes.count == 32,
      bytes.base64EncodedString() == key,
      metadata["SUFeedURL"] as? String == feed
    else {
      throw UpdateFailure.blocked(
        "Approved updater public key and signed-feed configuration are required")
    }
  }
  static func validateArchive(version: String, type: String, delta: Bool, url: URL?) throws {
    _ = try versionParts(version)
    guard type == "application", !delta,
      url?.absoluteString
        == "https://github.com/disjukr/rieul.app/releases/download/desktop-\(version)/rieul-macos-desktop.zip"
    else {
      throw UpdateFailure.blocked(
        "Only full application archives from the official versioned release are accepted")
    }
  }
}
