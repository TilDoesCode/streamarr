#if os(iOS)
import CryptoKit
import Foundation

enum FileHash {
  static func sha256(_ url: URL) throws -> String {
    guard let handle = try? FileHandle(forReadingFrom: url) else { throw EngineError(code: "not_found", detail: "missing \(url.lastPathComponent)") }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
#endif
