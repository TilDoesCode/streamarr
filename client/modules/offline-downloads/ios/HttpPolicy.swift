import Foundation

/// Status table, Retry-After and retry decisions; mirrored in http-policy.ts and HttpPolicy.kt (test-vectors/http-policy.json).
enum HttpPolicy {
  /// Printable, single-line, at most `limit` bytes (`…` when cut): an error body as a diagnostics line, never content.
  static func diagnosticBody(_ data: Data, limit: Int) -> String {
    let text = String(decoding: data.prefix(limit), as: UTF8.self).unicodeScalars.map { (0x20...0x7e).contains($0.value) ? Character($0) : " " }
    let line = String(text).split(whereSeparator: { $0 == " " }).joined(separator: " ")
    return line + (data.count > limit ? "…" : "")
  }

  static let maxAttempts = 8
  static let minRetryMs: Double = 2000
  static let maxBackoffMs: Double = 60000
  static let maxRetryAfterMs: Double = 60 * 60 * 1000
  static let maxServerWaitMs: Double = 12 * 60 * 60 * 1000
  static let progressResetsAttemptsBytes: Int64 = 1 << 20
  static let reserveBytes: Int64 = 64 * 1024 * 1024
  static let allowedHeaders: Set<String> = ["accept-language", "user-agent"]

  private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  private static let weekdays: Set<String> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

  /// True: retry natively (honouring Retry-After). False: fail at once with kind `http`.
  static func retryable(_ status: Int) -> Bool {
    status == 408 || status == 425 || status == 429 || (500...599).contains(status)
  }

  /// Retry-After (delta-seconds or IMF-fixdate) as the wait in ms, 2 s … 1 h; nil when absent or invalid.
  static func retryAfterMs(_ header: String?, now: Date = Date()) -> Double? {
    guard let value = header?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
    let ms: Double
    if value.allSatisfy(\.isASCIIDigit) {
      // Leading zeroes carry no magnitude; clamp before multiplying so huge values cannot overflow (N2-09).
      let digits = value.drop { $0 == "0" }
      ms = digits.count > 7 ? maxRetryAfterMs : Double(Int(digits) ?? 0) * 1000
    } else if let date = httpDate(value) {
      ms = (date - now.timeIntervalSince1970) * 1000
    } else {
      return nil
    }
    return min(maxRetryAfterMs, max(minRetryMs, ms)).rounded()
  }

  /// Seconds since 1970 of a strict IMF-fixdate (`Fri, 06 Nov 2026 20:00:40 GMT`), nil for anything else.
  private static func httpDate(_ value: String) -> Double? {
    let parts = value.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 6, parts[0].count == 4, parts[0].hasSuffix(","), weekdays.contains(String(parts[0].dropLast())),
      parts[1].count == 2, parts[3].count == 4, parts[5] == "GMT", let month = months.firstIndex(of: parts[2]),
      let day = digits(parts[1]), let year = digits(parts[3]) else { return nil }
    let time = parts[4].split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts[4].count == 8, time.count == 3, time.allSatisfy({ $0.count == 2 }),
      let hour = digits(time[0]), let minute = digits(time[1]), let second = digits(time[2]),
      hour <= 23, minute <= 59, second <= 59, day >= 1 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "GMT")!
    let components = DateComponents(year: year, month: month + 1, day: day, hour: hour, minute: minute, second: second)
    guard let date = calendar.date(from: components), calendar.component(.day, from: date) == day else { return nil }
    return date.timeIntervalSince1970
  }

  private static func digits(_ text: String) -> Int? { text.allSatisfy(\.isASCIIDigit) ? Int(text) : nil }

  /// Wait after the n-th ordinary failed attempt: 2 s, 4 s, … 60 s.
  static func backoffMs(_ attempts: Int) -> Double {
    min(maxBackoffMs, minRetryMs * pow(2, Double(min(max(attempts - 1, 0), 10))))
  }

  struct Decision: Equatable {
    let retry: Bool
    let attempts: Int
    let waitingSince: Double?
    let retryAt: Double?
  }

  /// What a failed attempt does to a task (same rules on Android and in the fake).
  static func decideRetry(attempts: Int, waitingSince: Double?, now: Double, retryable: Bool, retryAfterMs: Double?, progressBytes: Int64) -> Decision {
    var count = progressBytes >= progressResetsAttemptsBytes ? 0 : attempts
    let since = progressBytes > 0 ? nil : waitingSince
    guard retryable else { return Decision(retry: false, attempts: count + 1, waitingSince: since, retryAt: nil) }
    if let retryAfterMs {
      let start = since ?? now
      let retryAt = now + retryAfterMs
      return retryAt - start > maxServerWaitMs
        ? Decision(retry: false, attempts: count, waitingSince: start, retryAt: nil)
        : Decision(retry: true, attempts: count, waitingSince: start, retryAt: retryAt)
    }
    count += 1
    if count >= maxAttempts { return Decision(retry: false, attempts: count, waitingSince: since, retryAt: nil) }
    return Decision(retry: true, attempts: count, waitingSince: since, retryAt: now + backoffMs(count))
  }

  /// A persisted wait after a restart: elapsed time on the same boot, else the wall clock may only shorten it (N2-04).
  static func restoreWait(remainingMs: Double, originalMs: Double, sameBoot: Bool, elapsedMs: Double, wallMs: Double) -> (remainingMs: Double, consumedMs: Double) {
    let original = max(0, originalMs)
    let saved = min(max(remainingMs, 0), original)
    let remaining = sameBoot && elapsedMs >= 0 ? saved - elapsedMs : min(saved, saved - wallMs)
    let restored = min(max(remaining, 0), original)
    return (restored, saved - restored)
  }

  /// Header names outside the allowlist (capability URLs need no headers; background sessions follow redirects).
  static func disallowedHeaders(_ headers: [String: String]) -> [String] {
    headers.keys.filter { !allowedHeaders.contains($0.lowercased()) }.sorted()
  }

  /// Strict `bytes a-b/total` with a numeric total and a <= b < total.
  static func contentRange(_ header: String?) -> (start: Int64, end: Int64, total: Int64)? {
    guard let text = header?.trimmingCharacters(in: .whitespaces), text.hasPrefix("bytes ") else { return nil }
    let spec = text.dropFirst(6)
    let halves = spec.split(separator: "/", omittingEmptySubsequences: false)
    guard halves.count == 2 else { return nil }
    let bounds = halves[0].split(separator: "-", omittingEmptySubsequences: false)
    guard bounds.count == 2, [bounds[0], bounds[1], halves[1]].allSatisfy({ !$0.isEmpty && $0.count <= 18 && $0.allSatisfy(\.isASCIIDigit) }),
      let start = Int64(bounds[0]), let end = Int64(bounds[1]), let total = Int64(halves[1]), start <= end, end < total else { return nil }
    return (start, end, total)
  }

  static func isStrong(_ etag: String?) -> Bool {
    guard let etag else { return false }
    return etag.count >= 2 && etag.hasPrefix("\"") && etag.hasSuffix("\"")
  }
}

private extension Character {
  var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
