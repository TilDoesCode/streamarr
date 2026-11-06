import Foundation

// Verifier Swift repros (DL-N-verify1) turned around: each check asserts the correct outcome of the actual engine.
private final class FixtureTask: URLSessionDownloadTask, @unchecked Sendable {
  let serial: Int
  let http: HTTPURLResponse
  init(_ serial: Int, _ status: Int = 200, _ headers: [String: String] = ["ETag": "\"a\"", "Content-Length": "8"], generation: Int = 1) {
    self.serial = serial
    self.http = HTTPURLResponse(url: URL(string: "http://127.0.0.1:39321/f/8/test")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    super.init()
    taskDescription = "task#\(generation)"
  }
  override var taskIdentifier: Int { serial }
  override var response: URLResponse? { http }
  override func cancel() {}
  override func cancel(byProducingResumeData completionHandler: @escaping @Sendable (Data?) -> Void) { completionHandler(nil) }
  override func resume() {}
}

extension OfflineDownloadEngine {
  // All replayed callbacks and assertions run on the production engine's serial queue.
  func hostChecks() throws {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    for url in [supportURL, resumeURL, stagedURL] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
    ensureRoot()
    reconciled = true
    let target = try resolve("movie.bin", nil)
    let temp = supportURL.appendingPathComponent("fixture.tmp")
    let wifi = URLSession(configuration: .background(withIdentifier: "harness.wifi"))
    let other = URLSession(configuration: .background(withIdentifier: "harness.any"))
    let task = FixtureTask(1)
    var events: [String] = []
    let owner = NSObject()
    listeners[ObjectIdentifier(owner)] = (progress: { _ in events.append("progress") }, state: { event in events.append(event["state"] as! String) })

    func seed(_ state: String = DownloadStates.running, expected: Int64? = 8, pinned: String? = "\"a\"", current: FixtureTask? = nil) {
      records.removeAll(); order = ["task"]; urlTasks.removeAll(); intents.removeAll(); finishedTasks.removeAll()
      baseline.removeAll(); awaitingResumeData.removeAll(); probed.removeAll(); probing.removeAll(); meters.removeAll()
      deleteResumeData("task")
      try? FileManager.default.removeItem(at: stagedFile("task"))
      records["task"] = DownloadRecord(id: "task", url: "http://127.0.0.1:39321/f/8/test", headers: [:], relativePath: "movie.bin", volumeId: "internal",
        expectedBytes: expected, expectedEtag: pinned, title: nil, state: state, totalBytes: 8, etag: "\"a\"", createdAt: 0, updatedAt: 0, generation: 1)
      let running = current ?? task
      urlTasks["task"] = TaskRef(task: running, session: "harness.wifi", generation: 1, fromResumeData: false)
      try? FileManager.default.removeItem(at: target)
      try? FileManager.default.removeItem(at: temp)
      events.removeAll()
    }
    func finish(_ task: FixtureTask, body: String = "AAAABBBB", session: URLSession? = nil) throws {
      try Data(body.utf8).write(to: temp)
      urlSession(session ?? wifi, downloadTask: task, didFinishDownloadingTo: temp)
      urlSession(session ?? wifi, task: task, didCompleteWithError: nil)
    }
    func state() -> String? { records["task"]?.state }
    func errorKind() -> String? { records["task"]?.error?.kind }

    try check("normal completion publishes, then one final progress") {
      seed()
      urlSession(wifi, downloadTask: task, didWriteData: 8, totalBytesWritten: 8, totalBytesExpectedToWrite: 8)
      try finish(task)
      let size = try Data(contentsOf: target).count
      return state() == DownloadStates.completed && size == 8 && events.suffix(2) == ["completed", "progress"]
    }
    try check("missing pinned ETag fails validator_changed (was BUG missing pinned ETag accepted)") {
      seed()
      let missing = FixtureTask(1, 206, ["Content-Range": "bytes 4-7/8"])
      urlTasks["task"] = TaskRef(task: missing, session: "harness.wifi", generation: 1, fromResumeData: true)
      try finish(missing)
      return state() == DownloadStates.failed && errorKind() == "validator_changed" && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("final callback validates the ETag without progress (was BUG final callback skips ETag)") {
      seed()
      let changed = FixtureTask(1, 200, ["ETag": "\"b\"", "Content-Length": "8"])
      urlTasks["task"] = TaskRef(task: changed, session: "harness.wifi", generation: 1, fromResumeData: false)
      try finish(changed)
      return state() == DownloadStates.failed && errorKind() == "validator_changed"
    }
    try check("an adopted task is validated again (was BUG reconcile checkedResponse marker)") {
      seed()
      let changed = FixtureTask(1, 200, ["ETag": "\"b\"", "Content-Length": "8"])
      urlTasks["task"] = TaskRef(task: changed, session: "harness.wifi", generation: 1, fromResumeData: false)
      urlSession(wifi, downloadTask: changed, didWriteData: 8, totalBytesWritten: 8, totalBytesExpectedToWrite: 8)
      let stopped = intents["task"] != nil
      urlSession(wifi, task: changed, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return stopped && state() == DownloadStates.failed && errorKind() == "validator_changed"
    }
    try check("a stale task never publishes over the current one (was BUG stale task callback)") {
      seed(current: FixtureTask(2, generation: 2))
      records["task"]?.generation = 2
      urlTasks["task"] = TaskRef(task: FixtureTask(2, generation: 2), session: "harness.wifi", generation: 2, fromResumeData: false)
      try finish(FixtureTask(1, generation: 1))
      return state() == DownloadStates.running && urlTasks["task"]?.task.taskIdentifier == 2 && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("the same taskIdentifier from the other session is ignored (was BUG equal taskIdentifier)") {
      seed()
      urlSession(other, task: FixtureTask(1), didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return urlTasks["task"] != nil && state() == DownloadStates.running
    }
    try check("a pending pause wins over a late completion; resume publishes it (was BUG late completion overrides pause)") {
      seed(DownloadStates.paused)
      intents["task"] = .pause
      try finish(task)
      let staged = state() == DownloadStates.paused && records["task"]?.staged == true && !FileManager.default.fileExists(atPath: target.path)
      records["task"]?.state = DownloadStates.queued
      begin("task", blocked: nil)
      let size = try Data(contentsOf: target).count
      return staged && state() == DownloadStates.completed && size == 8
    }
    try check("unknown range total is rejected (was BUG unexpected range and unknown total pass)") {
      seed()
      var record = records["task"]!
      let failure = validate(FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 3-6/*"]), record: &record)
      return failure?.dropPartial == true && failure?.retryable == true
    }
    try check("the final size is checked without expectedBytes (was BUG absent expectedBytes skips size)") {
      seed(expected: nil)
      try finish(task, body: "AAAA")
      return state() == DownloadStates.failed && errorKind() == "size_mismatch"
    }
    try check("GET 503 after a good HEAD keeps the resume data (was BUG GET503 deletes resume data)") {
      seed()
      saveResumeData("task", Data("retained partial handle".utf8))
      let get503 = FixtureTask(1, 503, ["Retry-After": "40"])
      urlTasks["task"] = TaskRef(task: get503, session: "harness.wifi", generation: 1, fromResumeData: true)
      try finish(get503, body: "")
      return state() == DownloadStates.retrying && loadResumeData("task") != nil && records["task"]?.error?.retryAfterMs == 40000
    }
    try check("HEAD 416 drops the resume data (was BUG HEAD416 retains resume data)") {
      seed()
      saveResumeData("task", Data("old partial".utf8))
      handle("task", statusFailure(FixtureTask(1, 416).http)!)
      return state() == DownloadStates.failed && loadResumeData("task") == nil
    }
    try check("Retry-After answers wait at least 2 s and end after 12 h (was BUG 10000 Retry-After never exhaust)") {
      seed()
      let zero = statusFailure(FixtureTask(1, 429, ["Retry-After": "0"]).http)!
      for _ in 0..<10000 { handle("task", zero) }
      let floor = (records["task"]?.retryAt ?? 0) - nowMs >= 1900
      let waiting = state() == DownloadStates.retrying && records["task"]?.attempts == 0 && floor
      records["task"]?.waitingSince = nowMs - HttpPolicy.maxServerWaitMs + 1000
      handle("task", zero)
      return waiting && state() == DownloadStates.failed && records["task"]?.error?.httpStatus == 429
    }
    try check("eight ordinary failures stop") {
      seed()
      for _ in 0..<8 { handle("task", statusFailure(FixtureTask(1, 503, [:]).http)!) }
      return state() == DownloadStates.failed && records["task"]?.attempts == 8
    }
    try check("an unfinished task owns its path, case-insensitively") {
      seed()
      return try liveOwner("internal", "MOVIE.bin") == "task" && liveOwner("internal", "other.bin") == nil
        && Self.claimKey("internal", "a//./B") == "internal:a/b"
    }
    try check("free space is reserved before a start") {
      seed()
      return spaceFailure("other", total: Int64.max / 4, offset: 0)?.kind == "disk_full" && spaceFailure("other", total: 8, offset: 0) == nil
    }
    try check("durable writes replace the file") {
      let file = supportURL.appendingPathComponent("durable.json")
      try Self.writeDurably(Data("one".utf8), to: file)
      try Self.writeDurably(Data("two".utf8), to: file)
      return String(data: try Data(contentsOf: file), encoding: .utf8) == "two"
    }
    listeners.removeAll()
    print("Swift engine host: \(count)/\(count) checks passed")
  }
}

@main enum EngineHostCheck {
  static func main() throws {
    setvbuf(stdout, nil, _IOLBF, 0)
    let engine = OfflineDownloadEngine.shared
    try engine.queue.sync { try engine.hostChecks() }
  }
}
