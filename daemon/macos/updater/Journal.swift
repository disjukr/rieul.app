import Darwin
import Foundation

// Private user state is recovery bookkeeping, never privileged authorization.
// One descriptor stays open for the lifetime of the updater to exclude peers.
final class DurableStore<Record: Codable> {
  private let directory: URL
  private let lockFD: Int32
  private let directoryFD: Int32
  init(directory: URL) throws {
    self.directory = directory
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directoryFD >= 0 else {
      throw UpdateFailure.blocked("Cannot open private recovery directory")
    }
    var metadata = stat()
    guard fstat(directoryFD, &metadata) == 0, metadata.st_uid == geteuid(),
      metadata.st_mode & 0o077 == 0
    else {
      close(directoryFD)
      throw UpdateFailure.blocked("Recovery directory must be private and owned by this user")
    }
    lockFD = openat(directoryFD, "lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lockFD >= 0 else {
      close(directoryFD)
      throw UpdateFailure.blocked("Cannot open updater lock")
    }
    guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
      close(lockFD)
      close(directoryFD)
      throw UpdateFailure.blocked("Another updater is active")
    }
  }
  deinit {
    close(lockFD)
    close(directoryFD)
  }
  func load() throws -> Record? {
    let fd = openat(directoryFD, "transaction.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 && errno == ENOENT { return nil }
    guard fd >= 0 else { throw UpdateFailure.blocked("Cannot read recovery journal") }
    defer { close(fd) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
      metadata.st_uid == geteuid(), metadata.st_nlink == 1, metadata.st_size <= 4096
    else {
      throw UpdateFailure.blocked("Invalid recovery journal")
    }
    var bytes = [UInt8](repeating: 0, count: 4097)
    let count = read(fd, &bytes, bytes.count)
    guard count >= 0, count <= 4096 else {
      throw UpdateFailure.blocked("Cannot read recovery journal")
    }
    return try JSONDecoder().decode(Record.self, from: Data(bytes.prefix(count)))
  }
  func save(_ transaction: Record) throws {
    let data = try JSONEncoder().encode(transaction)
    let name = "transaction-\(UUID().uuidString).tmp"
    let fd = openat(directoryFD, name, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw UpdateFailure.blocked("Cannot create recovery journal") }
    defer {
      close(fd)
      unlinkat(directoryFD, name, 0)
    }
    let complete = data.withUnsafeBytes { bytes in
      write(fd, bytes.baseAddress, bytes.count) == bytes.count
    }
    guard complete, fsync(fd) == 0,
      renameat(directoryFD, name, directoryFD, "transaction.json") == 0,
      fsync(directoryFD) == 0
    else { throw UpdateFailure.blocked("Cannot durably commit recovery journal") }
  }
  func clear() throws {
    guard unlinkat(directoryFD, "transaction.json", 0) == 0 || errno == ENOENT,
      fsync(directoryFD) == 0
    else { throw UpdateFailure.blocked("Cannot clear recovery journal") }
  }
}

typealias FileJournal = DurableStore<Transaction>
extension DurableStore: TransactionStore where Record == Transaction {}
