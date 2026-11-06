// Run: xcrun swiftc -parse-as-library ios/HttpPolicy.swift ios/Tests/HttpPolicyCheck.swift -o /tmp/http-policy && /tmp/http-policy
import Foundation

@main
enum HttpPolicyCheck {
  static func main() {
    var failures = 0
    func expect(_ condition: Bool, _ label: String) {
      if !condition {
        failures += 1
        print("FAIL \(label)")
      }
    }
    for status in [400, 401, 403, 404, 409, 410, 416, 451] { expect(!HttpPolicy.retryable(status), "\(status) fails") }
    for status in [408, 425, 429, 500, 501, 502, 503, 504, 507, 599] { expect(HttpPolicy.retryable(status), "\(status) retries") }
    let now = Date(timeIntervalSince1970: 1_793_995_200)
    expect(HttpPolicy.retryAfterMs("40", now: now) == 40_000, "delta seconds")
    expect(HttpPolicy.retryAfterMs(" 0 ", now: now) == 0, "zero")
    expect(HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 20:01:30 GMT", now: now) == 90_000, "http date")
    expect(HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 19:59:00 GMT", now: now) == 0, "past date")
    expect(HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 20:00:03 GMT", now: now.addingTimeInterval(0.4)) == 2600, "whole ms")
    expect(HttpPolicy.retryAfterMs("86400") == HttpPolicy.maxRetryAfterMs, "cap")
    expect(HttpPolicy.retryAfterMs("soon") == nil, "garbage")
    expect(HttpPolicy.retryAfterMs("-5") == nil, "negative")
    expect(HttpPolicy.retryAfterMs("") == nil, "empty")
    expect(HttpPolicy.retryAfterMs(nil) == nil, "nil")
    print(failures == 0 ? "HttpPolicy: all checks passed" : "HttpPolicy: \(failures) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
