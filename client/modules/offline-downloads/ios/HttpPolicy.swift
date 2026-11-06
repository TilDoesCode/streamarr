import Foundation

/// What a response status does to a transfer; mirrored in src/downloads/engine/http-policy.ts and HttpPolicy.kt.
enum HttpPolicy {
  static let maxRetryAfterMs: Double = 60 * 60 * 1000

  /// True: retry natively (honouring Retry-After). False: fail at once with kind `http`.
  static func retryable(_ status: Int) -> Bool {
    status == 408 || status == 425 || status == 429 || (500...599).contains(status)
  }

  /// Retry-After (delta-seconds or IMF-fixdate) in ms, capped at an hour; nil when absent or unparsable.
  static func retryAfterMs(_ header: String?, now: Date = Date()) -> Double? {
    guard let value = header?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
    let ms: Double
    if value.allSatisfy(\.isASCIIDigit) {
      ms = (Double(value) ?? maxRetryAfterMs / 1000) * 1000
    } else if let date = httpDate.date(from: value) {
      ms = date.timeIntervalSince(now) * 1000
    } else {
      return nil
    }
    return min(maxRetryAfterMs, max(0, ms)).rounded()
  }

  private static let httpDate: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    return formatter
  }()
}

private extension Character {
  var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
