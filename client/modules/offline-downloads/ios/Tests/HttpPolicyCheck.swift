// cd client/modules/offline-downloads && xcrun swiftc -parse-as-library ios/HttpPolicy.swift ios/Tests/HttpPolicyCheck.swift
//   -o /tmp/http-policy && /tmp/http-policy test-vectors/http-policy.json
import CryptoKit
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
    for item in corpus["waitRestore"] as! [[String: Any]] {
      let wait = item["wait"] as! [String: Any]
      let change = item["change"] as! [String: Any]
      let expected = item["expect"] as! [String: Any]
      let restored = HttpPolicy.restoreWait(remainingMs: number(wait["remainingMs"])!, originalMs: number(wait["originalMs"])!,
        sameBoot: change["sameBoot"] as! Bool, elapsedMs: number(change["elapsedMs"])!, wallMs: number(change["wallMs"])!)
      expect(restored.remainingMs == number(expected["remainingMs"]) && restored.consumedMs == number(expected["consumedMs"]),
        "waitRestore \(item["name"] as! String) = \(restored)")
    }
    let diagnostics = corpus["diagnostics"] as! [[String: Any]]
    expect(diagnostics.count >= 10, "diagnostics vectors")
    for item in diagnostics {
      let line = HttpPolicy.diagnosticLine(status: Int(number(item["status"])!), contentType: item["contentType"] as? String,
        length: (item["length"] as? NSNumber)?.int64Value, body: Data((item["body"] as! String).utf8), cut: item["cut"] as! Bool,
        requestUrls: item["requestUrls"] as! [String])
      expect(line == item["expect"] as! String, "diagnostics \(item["name"] as! String) = \(line)")
    }
    // N4-01: the corpus's generated cases (see `redactionFuzz._comment`), the same lines as jest and JUnit.
    let fuzz = corpus["redactionFuzz"] as! [String: Any]
    var state = UInt32(number(fuzz["seed"])!)
    func int(_ n: Int) -> Int {
      state ^= state << 13
      state ^= state >> 17
      state ^= state << 5
      return Int(state % UInt32(n))
    }
    let hex = Array(fuzz["hex"] as! String)
    let queryChars = Array(fuzz["queryChars"] as! String)
    let hosts = fuzz["hosts"] as! [String]
    let prefixes = fuzz["prefixes"] as! [String]
    let pieces = fuzz["pieces"] as! [String]
    let delimiters = fuzz["delimiters"] as! [String]
    let types = (fuzz["contentTypes"] as! [Any]).map { $0 as? String }
    let targets = (fuzz["targets"] as! [NSNumber]).map(\.intValue)
    let readBytes = Int(number(fuzz["readBytes"])!)
    var lines: [String] = []
    var leaks = 0
    for _ in 0..<Int(number(fuzz["cases"])!) {
      let cap = String((0..<64).map { _ in hex[int(16)] })
      let host = hosts[int(hosts.count)]
      let q = int(4)
      let query = q == 0 ? "" : "?" + String((0..<q).map { _ in queryChars[int(queryChars.count)] })
      let prefix = prefixes[int(prefixes.count)]
      let scheme = int(2) == 0 ? "https" : "http"
      let path = "/api/v1/offline/\(cap)"
      let url = "\(scheme)://\(host)\(prefix)\(path)\(query)"
      let values = [("path", path), ("query", query), ("url", url), ("cap", cap), ("CAP", cap.uppercased()), ("filler", String(repeating: "x", count: int(300)))]
      func fill(_ template: String) -> String { values.reduce(template) { $0.replacingOccurrences(of: "{\($1.0)}", with: $1.1) } }
      let target = targets[int(targets.count)]
      var body = Data()
      while body.count < target {
        body.append(contentsOf: Array(fill(pieces[int(pieces.count)]).utf8))
        body.append(contentsOf: Array(delimiters[int(delimiters.count)].utf8))
      }
      if int(8) == 0 { body.append(contentsOf: [0xff, 0xfe, 0x80]) }
      let type = types[int(types.count)].map(fill)
      let length: Int64 = int(2) == 0 ? Int64(body.count) : -1
      let urls = int(2) == 0 ? [url, fill(fuzz["redirect"] as! String)] : [url]
      let line = HttpPolicy.diagnosticLine(status: Int(number(fuzz["status"])!), contentType: type, length: length, body: body.prefix(readBytes),
        cut: body.count > readBytes, requestUrls: urls)
      let lower = line.lowercased()
      let capChars = Array(cap)
      if (0...52).contains(where: { lower.contains(String(capChars[$0..<($0 + 12)])) }) { leaks += 1 }
      lines.append(line)
    }
    expect(readBytes == HttpPolicy.diagnosticReadBytes, "fuzz read limit")
    expect(leaks == 0, "fuzz: \(leaks) lines leak a 12-char capability window")
    let digest = SHA256.hash(data: Data(lines.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
    expect(digest == fuzz["digest"] as! String, "fuzz digest \(digest)")
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
