// cd client/modules/offline-downloads && xcrun swiftc -parse-as-library ios/HttpPolicy.swift ios/Tests/HttpPolicyCheck.swift
//   -o /tmp/http-policy && /tmp/http-policy test-vectors/http-policy.json
import Foundation

@main
enum HttpPolicyCheck {
  static func main() throws {
    let path = CommandLine.arguments.dropFirst().first ?? "test-vectors/http-policy.json"
    let corpus = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
    var failures = 0
    var checks = 0
    func expect(_ condition: Bool, _ label: String) {
      checks += 1
      if !condition {
        failures += 1
        print("FAIL \(label)")
      }
    }
    func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

    let constants = corpus["constants"] as! [String: Any]
    expect(number(constants["maxAttempts"]) == Double(HttpPolicy.maxAttempts), "maxAttempts")
    expect(number(constants["minRetryMs"]) == HttpPolicy.minRetryMs, "minRetryMs")
    expect(number(constants["maxBackoffMs"]) == HttpPolicy.maxBackoffMs, "maxBackoffMs")
    expect(number(constants["maxRetryAfterMs"]) == HttpPolicy.maxRetryAfterMs, "maxRetryAfterMs")
    expect(number(constants["maxServerWaitMs"]) == HttpPolicy.maxServerWaitMs, "maxServerWaitMs")
    expect(number(constants["progressResetsAttemptsBytes"]) == Double(HttpPolicy.progressResetsAttemptsBytes), "progress reset")
    expect(number(constants["reserveBytes"]) == Double(HttpPolicy.reserveBytes), "reserveBytes")

    let status = corpus["status"] as! [String: [Int]]
    for code in status["retry"]! { expect(HttpPolicy.retryable(code), "\(code) retries") }
    for code in status["fail"]! { expect(!HttpPolicy.retryable(code), "\(code) fails") }
    for code in 100...599 { expect(HttpPolicy.retryable(code) == ([408, 425, 429].contains(code) || code >= 500), "status \(code)") }

    let retryAfter = corpus["retryAfter"] as! [String: Any]
    let now = Date(timeIntervalSince1970: number(retryAfter["now"])! / 1000)
    for item in retryAfter["cases"] as! [[String: Any]] {
      let header = item["header"] as? String
      let got = HttpPolicy.retryAfterMs(header, now: now)
      expect(got == number(item["ms"]), "Retry-After \(String(describing: header)) = \(String(describing: got))")
    }
    for item in corpus["backoff"] as! [[String: Any]] {
      expect(HttpPolicy.backoffMs(Int(number(item["attempts"])!)) == number(item["ms"]), "backoff \(item)")
    }
    for sequence in corpus["retrySequences"] as! [[String: Any]] {
      let name = sequence["name"] as! String
      let start = sequence["start"] as! [String: Any]
      var attempts = Int(number(start["attempts"])!)
      var waitingSince = number(start["waitingSince"])
      for step in sequence["steps"] as! [[String: Any]] {
        let at = number(step["at"])!
        let code = (step["status"] as? NSNumber)?.intValue
        let retryable = code.map(HttpPolicy.retryable) ?? true
        let header = step["retryAfter"] as? String
        let decision = HttpPolicy.decideRetry(attempts: attempts, waitingSince: waitingSince, now: at, retryable: retryable,
          retryAfterMs: retryable ? HttpPolicy.retryAfterMs(header, now: Date(timeIntervalSince1970: at / 1000)) : nil,
          progressBytes: Int64(number(step["progressBytes"])!))
        let expected = step["expect"] as! [String: Any]
        let label = "\(name) @ \(Int64(at))"
        expect(decision.retry == ((expected["action"] as! String) == "retry"), "\(label) action")
        expect(decision.attempts == Int(number(expected["attempts"])!), "\(label) attempts")
        expect(decision.retryAt == number(expected["retryAt"]), "\(label) retryAt \(String(describing: decision.retryAt))")
        expect(decision.waitingSince == number(expected["waitingSince"]), "\(label) waitingSince")
        attempts = decision.attempts
        waitingSince = decision.waitingSince
      }
    }
    expect(HttpPolicy.disallowedHeaders(["Accept-Language": "de", "user-agent": "x"]).isEmpty, "allowed headers")
    expect(HttpPolicy.disallowedHeaders(["Authorization": "x"]) == ["Authorization"], "rejected header")
    expect(HttpPolicy.contentRange("bytes 4-7/8")! == (4, 7, 8), "content range")
    for bad in ["bytes 4-7/*", "bytes 4-2/8", "bytes 4-8/8", "bytes */8", "bytes 4-7/8 x", "bytes 4-7", "bytes -1-7/8"] {
      expect(HttpPolicy.contentRange(bad) == nil, "content range \(bad) rejected")
    }
    print(failures == 0 ? "HttpPolicy: \(checks)/\(checks) checks passed" : "HttpPolicy: \(failures) of \(checks) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
