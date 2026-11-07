import Foundation

// Verifier Swift repros (DL-N-verify1/2) turned around: each check asserts the correct outcome of the actual engine.
private final class FixtureTask: URLSessionDownloadTask, @unchecked Sendable {
  var delayResumeData = false
  var resumeCompletion: (@Sendable (Data?) -> Void)?
  let serial: Int
  /// The current response; an in-task OS retry switches it on the same task (D-03).
  var http: HTTPURLResponse
  init(_ serial: Int, _ status: Int = 200, _ headers: [String: String] = ["ETag": "\"a\"", "Content-Length": "8"], generation: Int = 1,
    url: String = "http://127.0.0.1:39321/f/8/test") {
    self.serial = serial
    self.http = HTTPURLResponse(url: URL(string: url)!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    super.init()
    taskDescription = "task#\(generation)"
  }
  /// The Range the OS put on the request (an in-task retry or the engine's own Range continuation).
  var requestRange: String?
  override var taskIdentifier: Int { serial }
  override var response: URLResponse? { http }
  override var currentRequest: URLRequest? {
    var request = URLRequest(url: http.url!)
    if let requestRange { request.setValue(requestRange, forHTTPHeaderField: "Range") }
    return request
  }
  /// What `cancel(byProducingResumeData:)` hands back, and how often the task was cancelled.
  var producedResumeData: Data?
  var cancels = 0
  override func cancel() { cancels += 1 }
  override func cancel(byProducingResumeData completionHandler: @escaping @Sendable (Data?) -> Void) {
    cancels += 1
    if delayResumeData { resumeCompletion = completionHandler } else { completionHandler(producedResumeData) }
  }
  override func resume() {}
}

extension OfflineDownloadEngine {
  // All replayed callbacks and assertions run on the production engine's serial queue.
  func hostChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    for url in [supportURL, resumeURL, stagedURL, keptURL, osDownloadsURL, osTempURL] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
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
      removeKeptFiles("task")
      clearTaskTracking("task")
      assembling.removeAll()
      for dir in [osDownloadsURL, osTempURL] {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] { try? FileManager.default.removeItem(at: dir.appendingPathComponent(name)) }
      }
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
    try check("a 200 answer to a resume counts one restart, not one per validation") {
      seed(pinned: nil)
      baseline["task"] = 4
      urlSession(wifi, downloadTask: task, didWriteData: 8, totalBytesWritten: 8, totalBytesExpectedToWrite: 8)
      try finish(task)
      return state() == DownloadStates.completed && records["task"]?.restarts == 1
    }
    try check("a task that finished while the app was gone is adopted and published, not downloaded again") {
      seed()
      urlTasks.removeAll()
      try finish(task)
      let size = try Data(contentsOf: target).count
      return state() == DownloadStates.completed && size == 8 && urlTasks.isEmpty
    }
    try check("an adopted task whose response was validated before the relaunch finishes without a restart (device: restarts 1)") {
      seed()
      records["task"]?.validatedGeneration = 1
      records["task"]?.bytesWritten = 6
      urlTasks.removeAll()
      try finish(task)
      return state() == DownloadStates.completed && records["task"]?.restarts == 0
    }
    try check("a finished task is not adopted by a paused download") {
      seed()
      urlTasks.removeAll()
      records["task"]?.state = DownloadStates.paused
      try finish(task)
      return state() == DownloadStates.paused && !FileManager.default.fileExists(atPath: target.path)
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
      let failure = validate(FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 3-6/*"]), generation: 1, record: &record)
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
      let floor = (records["task"]?.retryDue ?? 0) - elapsedMs >= 1900
      let waiting = state() == DownloadStates.retrying && records["task"]?.attempts == 0 && floor
      records["task"]?.waitingSince = elapsedMs - HttpPolicy.maxServerWaitMs + 1000
      handle("task", zero)
      return waiting && state() == DownloadStates.failed && records["task"]?.error?.httpStatus == 429
    }
    func resumed(_ response: FixtureTask, offset: Int64?) {
      seed(pinned: nil, current: response)
      baseline["task"] = 4
      records["task"]?.bytesWritten = 4
      records["task"]?.resumeOffset = offset
      records["task"]?.resumeOffsetGeneration = offset == nil ? nil : 1
      urlTasks["task"] = TaskRef(task: response, session: "harness.wifi", generation: 1, fromResumeData: true)
      saveResumeData("task", Data("partial".utf8))
    }
    try check("a 206 starting elsewhere than the OS resumed restarts from 0 (was REPRO N2 Content-Range start)") {
      let malformed = FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 3-7/8", "Content-Length": "5"])
      resumed(malformed, offset: 4)
      try finish(malformed, body: "AAABBBBB")
      return state() == DownloadStates.retrying && !FileManager.default.fileExists(atPath: target.path) && loadResumeData("task") == nil
        && records["task"]?.bytesWritten == 0
    }
    try check("a 206 continuing the OS resume offset with the recorded ETag completes") {
      let good = FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 4-7/8", "Content-Length": "4"])
      resumed(good, offset: 4)
      try finish(good)
      return state() == DownloadStates.completed
    }
    try check("a 206 without a recorded validator restarts from 0 (no ?? true)") {
      let good = FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 4-7/8", "Content-Length": "4"])
      resumed(good, offset: 4)
      records["task"]?.etag = nil
      try finish(good)
      return state() == DownloadStates.retrying && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("a 206 without a reported resume offset restarts from 0") {
      let good = FixtureTask(1, 206, ["ETag": "\"a\"", "Content-Range": "bytes 4-7/8", "Content-Length": "4"])
      resumed(good, offset: nil)
      try finish(good)
      return state() == DownloadStates.retrying && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("the final callback keeps a requested failure (was REPRO N2 final callback overrides failure)") {
      seed()
      intents["task"] = .failure(Failure(error: DownloadErrorInfo(kind: "disk_full", message: "reserve exhausted"), retryable: false))
      try finish(task)
      return state() == DownloadStates.failed && errorKind() == "disk_full" && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("the final callback after a request replacement discards the old file (was REPRO N2 request replacement)") {
      seed(pinned: nil)
      records["task"]?.url = "http://new.fixture/replacement"
      intents["task"] = .replace
      try finish(task, body: "OLDOLD!!")
      return state() == DownloadStates.queued && !FileManager.default.fileExists(atPath: target.path) && records["task"]?.bytesWritten == 0
    }
    try check("bytes an https request got after a redirect to http are never published (device: the OS follows it)") {
      seed()
      records["task"]?.url = "https://127.0.0.1:39443/f/8/test"
      urlSession(wifi, downloadTask: task, didWriteData: 8, totalBytesWritten: 8, totalBytesExpectedToWrite: 8)
      try finish(task)
      return state() == DownloadStates.failed && errorKind() == "network" && records["task"]?.error?.message == "redirect https → http refused"
        && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("https end to end still publishes") {
      seed()
      records["task"]?.url = "https://127.0.0.1:39443/f/8/test"
      let secure = FixtureTask(1, url: "https://127.0.0.1:39443/f/8/test")
      urlTasks["task"] = TaskRef(task: secure, session: "harness.wifi", generation: 1, fromResumeData: false)
      try finish(secure)
      return state() == DownloadStates.completed && (try? Data(contentsOf: target).count) == 8
    }
    try check("a 206 the OS fetched inside the task continues at the Range it requested (reset, no didResumeAtOffset; N2-07)") {
      seed(pinned: nil)
      let inTask = FixtureTask(1, 206, ["Content-Range": "bytes 4-7/8", "ETag": "\"a\""])
      inTask.requestRange = "bytes=4-"
      urlTasks["task"] = TaskRef(task: inTask, session: "harness.wifi", generation: 1, fromResumeData: false)
      try finish(inTask)
      return state() == DownloadStates.completed && records["task"]?.restarts == 0
    }
    try check("an in-task 206 starting elsewhere than its requested Range restarts from 0 (N2-07)") {
      seed(pinned: nil)
      // The OS asked for bytes=4-: the 4 bytes before it were reported (D-02 counts a restart only for lost bytes).
      records["task"]?.bytesWritten = 4
      let shifted = FixtureTask(1, 206, ["Content-Range": "bytes 5-7/8", "ETag": "\"a\""])
      shifted.requestRange = "bytes=4-"
      urlTasks["task"] = TaskRef(task: shifted, session: "harness.wifi", generation: 1, fromResumeData: false)
      try finish(shifted)
      return state() == DownloadStates.retrying && records["task"]?.restarts == 1 && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("an in-task 206 at an unknown offset keeps the engine's clone, drops the OS partial and continues with Range (N2-12)") {
      seed()
      try Data("AAAA".utf8).write(to: keptFile("task"))
      records["task"]?.keptBytes = 4
      records["task"]?.keptEtag = "\"a\""
      records["task"]?.bytesWritten = 4
      saveResumeData("task", Data("unverifiable OS partial".utf8))
      let unknown = FixtureTask(1, 206, ["Content-Range": "bytes 4-7/8", "ETag": "\"a\""])
      urlTasks["task"] = TaskRef(task: unknown, session: "harness.wifi", generation: 1, fromResumeData: false)
      urlSession(wifi, downloadTask: unknown, didWriteData: 2, totalBytesWritten: 6, totalBytesExpectedToWrite: 8)
      urlSession(wifi, task: unknown, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return state() == DownloadStates.retrying && records["task"]?.restarts == 0 && records["task"]?.bytesWritten == 4
        && records["task"]?.keptBytes == 4 && loadResumeData("task") == nil && fileSize(keptFile("task")) == 4
    }
    try check("a clone of the OS partial is cut to the reported bytes, and skipped once the OS file is shorter (N2-12)") {
      seed()
      records["task"]?.validatedGeneration = 1
      osFiles["task"] = "CFNetworkDownload_pre.tmp"
      let os = osDownloadsURL.appendingPathComponent("CFNetworkDownload_pre.tmp")
      try Data("AAAAAA".utf8).write(to: os)
      responseKeys["task"] = Self.responseKey(task, 1)
      taskBytes["task"] = 4
      lastProgress["task"] = elapsedMs - 2000
      snapshotTick()
      let cut = records["task"]?.keptBytes == 4 && (try? Data(contentsOf: keptFile("task"))) == Data("AAAA".utf8) && preallocationLogged
      try Data("AA".utf8).write(to: os)
      taskBytes["task"] = 5
      lastProgress["task"] = elapsedMs - 2000
      snapshotTick()
      return cut && records["task"]?.keptBytes == 4 && fileSize(keptFile("task")) == 4
    }
    try check("a 410 body the OS fetched inside the task is never counted; the kept clone survives the truncation (N2-12)") {
      seed()
      records["task"]?.validatedGeneration = 1
      osFiles["task"] = "CFNetworkDownload_cut.tmp"
      let os = osDownloadsURL.appendingPathComponent("CFNetworkDownload_cut.tmp")
      try Data("AAAAAA".utf8).write(to: os)
      responseKeys["task"] = Self.responseKey(task, 1)
      taskBytes["task"] = 6
      lastProgress["task"] = elapsedMs - 2000
      snapshotTick()
      // The OS retried inside the task, got 410 and truncated its file to the error body.
      try Data("{\"code\":\"capability_revoked\"}".utf8).write(to: os)
      let gone = FixtureTask(1, 410, ["Content-Length": "28"])
      urlTasks["task"] = TaskRef(task: gone, session: "harness.wifi", generation: 1, fromResumeData: false)
      urlSession(wifi, downloadTask: gone, didWriteData: 28, totalBytesWritten: 28, totalBytesExpectedToWrite: 28)
      urlSession(wifi, task: gone, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return state() == DownloadStates.failed && records["task"]?.error?.httpStatus == 410 && records["task"]?.bytesWritten == 6
        && (try? Data(contentsOf: keptFile("task"))) == Data("AAAAAA".utf8) && records["task"]?.keptEtag == "\"a\""
    }
    try check("after a relaunch (validated, response not seen yet) a 410 body is still never counted (N2-12)") {
      seed()
      records["task"]?.validatedGeneration = 1
      records["task"]?.bytesWritten = 6
      let gone = FixtureTask(1, 410, ["Content-Length": "28"])
      urlTasks["task"] = TaskRef(task: gone, session: "harness.wifi", generation: 1, fromResumeData: false)
      urlSession(wifi, downloadTask: gone, didWriteData: 28, totalBytesWritten: 28, totalBytesExpectedToWrite: 28)
      let uncounted = records["task"]?.bytesWritten != 28
      urlSession(wifi, task: gone, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return uncounted && state() == DownloadStates.failed && records["task"]?.error?.httpStatus == 410 && records["task"]?.bytesWritten == 0
        && records["task"]?.restarts == 1
    }
    try check("resume data, then a 410 retry: offset and ETag are kept; a new URL continues with Range + If-Range there (N2-12)") {
      seed()
      sessions[true] = wifi
      sessions[false] = wifi
      let os = osDownloadsURL.appendingPathComponent("CFNetworkDownload_rd.tmp")
      try Data("AAAA".utf8).write(to: os)
      let blob: NSDictionary = ["NSURLSessionResumeInfoTempFileName": "CFNetworkDownload_rd.tmp", "NSURLSessionResumeBytesReceived": 4,
        "NSURLSessionResumeEntityTag": "\"a\"", "NSURLSessionDownloadURL": records["task"]!.url]
      // Laid out like a device blob: the root key is the literal "NSKeyedArchiveRootObjectKey".
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      archiver.encode(blob, forKey: "NSKeyedArchiveRootObjectKey")
      archiver.finishEncoding()
      saveResumeData("task", archiver.encodedData)
      urlTasks.removeAll()
      handle("task", statusFailure(FixtureTask(1, 410).http)!)
      let kept = state() == DownloadStates.failed && records["task"]?.bytesWritten == 4 && loadResumeData("task") != nil
      records["task"]?.url = "http://renewed.fixture/f/8/test"
      records["task"]?.state = DownloadStates.queued
      begin("task", blocked: nil)
      let request = urlTasks["task"]?.task.originalRequest
      let range = request?.value(forHTTPHeaderField: "Range") == "bytes=4-" && request?.value(forHTTPHeaderField: "If-Range") == "\"a\""
      let record = records["task"]
      urlTasks["task"]?.task.cancel()
      sessions.removeAll()
      return kept && range && record?.rangeOffset == 4 && record?.rangeGeneration == record?.generation && record?.keptBytes == 4
        && loadResumeData("task") == nil && (try? Data(contentsOf: keptFile("task"))) == Data("AAAA".utf8)
    }
    try check("resume data is cloned when it arrives: after nsurlsessiond purges its file the resume continues with Range (N2-12)") {
      seed(DownloadStates.paused)
      sessions[true] = wifi
      sessions[false] = wifi
      urlTasks.removeAll()
      let os = osDownloadsURL.appendingPathComponent("CFNetworkDownload_pause.tmp")
      try Data("AAAAAA".utf8).write(to: os)
      let blob: NSDictionary = ["NSURLSessionResumeInfoTempFileName": "CFNetworkDownload_pause.tmp", "NSURLSessionResumeBytesReceived": 6,
        "NSURLSessionResumeEntityTag": "\"a\"", "NSURLSessionDownloadURL": records["task"]!.url]
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      archiver.encode(blob, forKey: "NSKeyedArchiveRootObjectKey")
      archiver.finishEncoding()
      saveResumeData("task", archiver.encodedData)
      let cloned = records["task"]?.keptBytes == 6
      try FileManager.default.removeItem(at: os)
      records["task"]?.state = DownloadStates.queued
      begin("task", blocked: nil)
      let request = urlTasks["task"]?.task.originalRequest
      urlTasks["task"]?.task.cancel()
      sessions.removeAll()
      return cloned && request?.value(forHTTPHeaderField: "Range") == "bytes=6-" && loadResumeData("task") == nil
        && (try? Data(contentsOf: keptFile("task"))) == Data("AAAAAA".utf8)
    }
    try check("a paused partial the daemon moved to tmp/ is found by its blob's name: kept, and the resume uses the blob (device)") {
      seed(DownloadStates.paused)
      sessions[true] = wifi
      sessions[false] = wifi
      urlTasks.removeAll()
      try Data("AAAAAA".utf8).write(to: osTempURL.appendingPathComponent("CFNetworkDownload_moved.tmp"))
      let blob: NSDictionary = ["NSURLSessionResumeInfoTempFileName": "CFNetworkDownload_moved.tmp", "NSURLSessionResumeBytesReceived": 6,
        "NSURLSessionResumeEntityTag": "\"a\"", "NSURLSessionDownloadURL": records["task"]!.url]
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      archiver.encode(blob, forKey: "NSKeyedArchiveRootObjectKey")
      archiver.finishEncoding()
      saveResumeData("task", archiver.encodedData)
      let kept = records["task"]?.keptBytes == 6 && (try? Data(contentsOf: keptFile("task"))) == Data("AAAAAA".utf8)
      records["task"]?.state = DownloadStates.queued
      probed.insert("task")
      begin("task", blocked: nil)
      let resumed = urlTasks["task"]?.fromResumeData == true && self.osFile("task")?.path == osTempURL.appendingPathComponent("CFNetworkDownload_moved.tmp").path
      urlTasks["task"]?.task.cancel()
      sessions.removeAll()
      return kept && resumed && loadResumeData("task") != nil
    }
    try check("an error answer's body is one truncated log line, never content (N2-12, N3-07)") {
      let production = diagnostic
      var lines: [String] = []
      diagnostic = { lines.append($0) }
      defer { diagnostic = production }
      seed()
      let gone = FixtureTask(1, 410, ["Content-Type": "application/json"])
      urlTasks["task"] = TaskRef(task: gone, session: "harness.wifi", generation: 1, fromResumeData: false)
      try finish(gone, body: "{\"code\":\n\"capability_revoked\"}" + String(repeating: "x ", count: 150))
      let expected = "task: HTTP 410 type=application/json length=unknown body: {\"code\": \"capability_revoked\"}" + String(repeating: "x ", count: 49) + "…"
      return lines == [expected] && state() == DownloadStates.failed && records["task"]?.error?.httpStatus == 410
        && !FileManager.default.fileExists(atPath: target.path) && !FileManager.default.fileExists(atPath: stagedFile("task").path)
    }
    try check("a 403 retry keeps the bytes too; only 416, validator_changed and size_mismatch drop them (N2-12)") {
      seed()
      try Data("AAAA".utf8).write(to: keptFile("task"))
      records["task"]?.keptBytes = 4
      records["task"]?.keptEtag = "\"a\""
      handle("task", statusFailure(FixtureTask(1, 403).http)!)
      let forbidden = state() == DownloadStates.failed && records["task"]?.bytesWritten == 4 && fileSize(keptFile("task")) == 4
      records["task"]?.state = DownloadStates.running
      handle("task", statusFailure(FixtureTask(1, 416).http)!)
      return forbidden && records["task"]?.keptBytes == nil && !FileManager.default.fileExists(atPath: keptFile("task").path)
    }
    try check("loading drops kept files without a record and records whose kept file is gone (N2-12)") {
      seed()
      try Data("XX".utf8).write(to: keptURL.appendingPathComponent("orphan"))
      records["task"]?.keptBytes = 4
      records["task"]?.keptEtag = "\"a\""
      persist()
      records.removeAll()
      order.removeAll()
      load()
      return records["task"]?.keptBytes == nil && !FileManager.default.fileExists(atPath: keptURL.appendingPathComponent("orphan").path)
    }
    // Was REPRO N3 OS-file heuristic (DL-N-verify3 N3-01): without its own resume data naming the file, a task clones nothing.
    func runningWithPausedNeighbour() {
      seed()
      records["task"]?.validatedGeneration = 1
      records["other"] = DownloadRecord(id: "other", url: "http://127.0.0.1:39321/f/8/other", headers: [:], relativePath: "other.bin", volumeId: "internal",
        expectedBytes: 8, expectedEtag: "\"a\"", title: nil, state: DownloadStates.paused, totalBytes: 8, etag: "\"a\"", createdAt: 0, updatedAt: 0, generation: 1)
      order = ["task", "other"]
      responseKeys["task"] = Self.responseKey(task, 1)
      taskBytes["task"] = 4
    }
    func osFile(_ name: String, _ data: Data, age: TimeInterval = 0) throws {
      let url = osDownloadsURL.appendingPathComponent(name)
      try data.write(to: url)
      if age > 0 { try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: url.path) }
    }
    func noForeignBytes() -> Bool { records["task"]?.keptBytes == nil && !FileManager.default.fileExists(atPath: keptFile("task").path) }
    try check("ambiguous OS files (the task's own and a paused neighbour's) give no clone (N3-01)") {
      runningWithPausedNeighbour()
      try osFile("CFNetworkDownload_A.tmp", Data("AAAA".utf8))
      try osFile("CFNetworkDownload_B.tmp", Data("BBBB".utf8))
      return !snapshot("task") && noForeignBytes()
    }
    try check("the task's OS file >= 1 MiB ahead never makes a paused neighbour's partial its kept bytes (was REPRO N3, N3-01)") {
      runningWithPausedNeighbour()
      try osFile("CFNetworkDownload_A.tmp", Data(repeating: 0x41, count: 4 + (1 << 20)))
      try osFile("CFNetworkDownload_B.tmp", Data("BBBB".utf8))
      lastProgress["task"] = elapsedMs - 2000
      snapshotTick()
      return !snapshot("task") && noForeignBytes()
    }
    try check("a stall longer than 10 s never makes a paused neighbour's partial its kept bytes (was REPRO N3, N3-01)") {
      runningWithPausedNeighbour()
      try osFile("CFNetworkDownload_A.tmp", Data("AAAA".utf8), age: 20)
      try osFile("CFNetworkDownload_B.tmp", Data("BBBB".utf8), age: 3)
      lastProgress["task"] = elapsedMs - 20_000
      snapshotTick()
      return !snapshot("task") && noForeignBytes()
    }
    try check("the file its resume data names is cloned, cut to the reported bytes even >= 1 MiB ahead (N3-01, length cap)") {
      runningWithPausedNeighbour()
      osFiles["task"] = "CFNetworkDownload_A.tmp"
      try osFile("CFNetworkDownload_A.tmp", Data(repeating: 0x41, count: 4 + (1 << 20)))
      try osFile("CFNetworkDownload_B.tmp", Data("BBBB".utf8))
      return snapshot("task") && (try? Data(contentsOf: keptFile("task"))) == Data("AAAA".utf8) && records["task"]?.keptBytes == 4
    }
    try check("an in-task 410 of a task without resume data keeps nothing: the next attempt restarts from 0 (N3-01 limitation)") {
      runningWithPausedNeighbour()
      taskBytes["task"] = 6
      records["task"]?.bytesWritten = 6
      try osFile("CFNetworkDownload_A.tmp", Data("AAAAAA".utf8))
      lastProgress["task"] = elapsedMs - 2000
      snapshotTick()
      try osFile("CFNetworkDownload_A.tmp", Data("{\"code\":\"capability_revoked\"}".utf8))
      let gone = FixtureTask(1, 410, ["Content-Length": "28"])
      urlTasks["task"] = TaskRef(task: gone, session: "harness.wifi", generation: 1, fromResumeData: false)
      urlSession(wifi, downloadTask: gone, didWriteData: 28, totalBytesWritten: 28, totalBytesExpectedToWrite: 28)
      urlSession(wifi, task: gone, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      return state() == DownloadStates.failed && records["task"]?.bytesWritten == 0 && records["task"]?.restarts == 1 && noForeignBytes()
    }
    try check("an error body echoing the request path is redacted in the log (was REPRO N3 echoed capability, N3-07)") {
      let production = diagnostic
      var lines: [String] = []
      diagnostic = { lines.append($0) }
      defer { diagnostic = production }
      let request = "http://127.0.0.1:39321/api/v1/download/DUMMY-CAPABILITY-task?sig=0f0f0f"
      var echoed: [String] = []
      for path in ["DUMMY-CAPABILITY-task", "DUMMY-CAPABILITY-0123456789"] {
        seed()
        records["task"]?.url = request
        let missing = FixtureTask(1, 404, ["Content-Type": "text/html"], url: request)
        urlTasks["task"] = TaskRef(task: missing, session: "harness.wifi", generation: 1, fromResumeData: false)
        try finish(missing, body: "<p>The requested URL /api/v1/download/\(path) was not found on this server.</p>")
        echoed.append(contentsOf: lines)
        lines.removeAll()
      }
      return echoed == [
        "task: HTTP 404 type=text/html length=unknown body: <p>The requested URL [redacted] was not found on this server.</p>",
        "task: HTTP 404 type=text/html length=unknown body: <p>The requested URL /api/v1/download/[redacted] was not found on this server.</p>",
      ]
    }
    try check("a stale assembly completion leaves the current generation's tail alone (was REPRO N3 stale assembly, N3-09)") {
      seed()
      records["task"]?.generation = 20
      assembling["task"] = 20
      let current = tailFile("task", 20)
      try Data("CURRENT".utf8).write(to: current)
      finishAssembly("task", generation: 19, appended: false, pausing: false)
      let untouched = assembling["task"] == 20 && (try? Data(contentsOf: current)) == Data("CURRENT".utf8)
      assembling.removeAll()
      removeKeptFiles("task")
      return untouched && !FileManager.default.fileExists(atPath: current.path)
    }
    try check("every registered task but a completed one or a tombstone owns its path, paused and failed too (N3-02)") {
      seed()
      urlTasks.removeAll()
      let states = [DownloadStates.paused, DownloadStates.failed, DownloadStates.queued, DownloadStates.retrying, DownloadStates.completed, DownloadStates.cancelled]
      let owners = try states.map { state -> String? in
        records["task"]?.state = state
        return try liveOwner("internal", "Movie.bin")
      }
      return owners == ["task", "task", "task", "task", nil, nil]
    }
    try check("a same-request requeue (session move) still publishes the finished file") {
      seed()
      intents["task"] = .requeue
      try finish(task)
      return state() == DownloadStates.completed
    }
    try check("a wait restores without growing after a reboot and keeps its deadline on the same boot (N2-04)") {
      func restored(_ clock: SavedClock) -> Double {
        var record = records["task"]!
        record.retryDue = elapsedMs + 3_600_000
        record.retryDelay = 3_600_000
        restoreWait(&record, StoredState(settings: settings, tasks: [], clock: clock))
        return (record.retryDue ?? 0) - elapsedMs
      }
      seed(DownloadStates.retrying)
      let rollback = restored(SavedClock(bootId: "another-boot", elapsed: elapsedMs, wall: nowMs + 86_400_000))
      let forward = restored(SavedClock(bootId: "another-boot", elapsed: elapsedMs, wall: nowMs - 7_200_000))
      let sameBoot = restored(SavedClock(bootId: Self.bootId, elapsed: elapsedMs - 600_000, wall: nowMs + 86_400_000))
      return abs(rollback - 3_600_000) < 2_000 && forward <= 0 && abs(sameBoot - 3_600_000) < 2_000 && Self.bootId != nil
    }
    try check("the clock source is the sleep-inclusive one: it matches CLOCK_MONOTONIC_RAW (N2-04)") {
      let source = continuousMs()
      let monotonicRaw = Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000
      let uptimeRaw = Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000
      // Equal on a host that never slept; after a sleep CLOCK_UPTIME_RAW lags by the time slept.
      print(String(format: "  (CLOCK_UPTIME_RAW lags by %.0f s on this host)", max(0, monotonicRaw - uptimeRaw) / 1000))
      return abs(source - monotonicRaw) < 50 && monotonicRaw + 50 >= uptimeRaw
    }
    try check("waits run on the faked clock source alone: a sleep makes a retry due, the wall clock does not (N2-04)") {
      let production = continuousMs
      var fake = 5_000_000.0
      continuousMs = { fake }
      defer {
        urlTasks["task"]?.task.cancel()
        sessions.removeAll()
        retryTimer?.cancel()
        retryTimer = nil
        continuousMs = production
      }
      seed(DownloadStates.retrying)
      urlTasks.removeAll()
      sessions[true] = wifi
      sessions[false] = wifi
      records["task"]?.retryDue = fake + 30_000
      records["task"]?.retryDelay = 30_000
      // The displayed wall-clock time is long past (a clock change): the wait must still hold.
      records["task"]?.retryAt = nowMs - 3_600_000
      pump()
      let waiting = urlTasks["task"] == nil && state() == DownloadStates.retrying && retryTimer != nil
      // The device slept 30 s: only the sleep-inclusive source moved.
      fake += 30_000
      pump()
      return waiting && urlTasks["task"] != nil
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
    return count
  }

  /// Fix round 1c through the public API: every call hops onto the engine queue, so these run outside it.
  func tombstoneChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    func value(_ map: [String: Any?]?, _ key: String) -> Any? {
      guard let map, let entry = map[key] else { return nil }
      return entry
    }
    func record(_ id: String, _ state: String, _ path: String) -> DownloadRecord {
      DownloadRecord(id: id, url: "http://127.0.0.1:9/\(id)", headers: [:], relativePath: path, volumeId: "internal", expectedBytes: 8,
        expectedEtag: nil, title: nil, state: state, bytesWritten: 4, totalBytes: 8, etag: "\"a\"", createdAt: 0, updatedAt: 0, generation: 1)
    }
    var events: [[String: Any?]] = []
    let owner = NSObject()
    queue.sync {
      reconciled = false
      records.removeAll(); urlTasks.removeAll(); intents.removeAll()
      order = ["t", "p", "done"]
      records["t"] = record("t", DownloadStates.running, "dir/movie.bin")
      records["p"] = record("p", DownloadStates.paused, "dir/paused.bin")
      records["done"] = record("done", DownloadStates.completed, "dir/done.bin")
      urlTasks["t"] = TaskRef(task: FixtureTask(7), session: "harness.wifi", generation: 1, fromResumeData: false)
      saveResumeData("t", Data("resume".utf8))
      listeners[ObjectIdentifier(owner)] = (progress: { _ in }, state: { events.append($0) })
    }
    try check("a cancel outside the app leaves a cancelled tombstone: bytes 0, no error, resume data gone") {
      try cancelOutsideApp("t")
      let task = get("t")
      let event = value(events.last, "task") as? [String: Any?]
      return value(task, "state") as? String == DownloadStates.cancelled && value(task, "bytesWritten") as? Double == 0
        && value(task, "error") == nil && value(events.last, "state") as? String == DownloadStates.cancelled
        && value(event, "bytesWritten") as? Double == 0 && value(event, "error") == nil
        && queue.sync { loadResumeData("t") == nil && urlTasks["t"] == nil }
    }
    try check("a tombstone frees its path; its own id comes back unchanged") {
      let next = try start(["id": "c", "url": "http://127.0.0.1:9/c", "relativePath": "DIR//movie.bin"])
      let same = try start(["id": "t", "url": "http://127.0.0.1:9/t", "relativePath": "dir/movie.bin"])
      return value(next, "state") as? String == DownloadStates.queued && value(same, "state") as? String == DownloadStates.cancelled
    }
    try check("the tombstone survives a relaunch") {
      queue.sync { records.removeAll(); order.removeAll(); load() }
      return list().compactMap { value($0, "id") as? String } == ["t", "p", "done", "c"]
        && value(get("t"), "state") as? String == DownloadStates.cancelled && value(get("t"), "bytesWritten") as? Double == 0
    }
    try check("the app's cancel only forgets a tombstone (no event, the path's new owner stays)") {
      let before = events.count
      try cancel("t")
      return get("t") == nil && events.count == before && value(get("c"), "state") as? String == DownloadStates.queued
    }
    try check("a path ending in .part is rejected; staging paths and directories around are claimed (N2-01)") {
      let partial = (try? start(["id": "x1", "url": "http://127.0.0.1:9/x", "relativePath": "dir/movie.bin.PART"])) == nil
      let codes = ["DIR/movie.bin.part/x", "dir/movie.bin/x", "dir"].map { path -> String? in
        do { _ = try start(["id": "x-\(path)", "url": "http://127.0.0.1:9/x", "relativePath": path]); return nil } catch let error as EngineError { return error.code } catch { return "?" }
      }
      return partial && codes == ["invalid_state", "invalid_state", "invalid_state"]
    }
    try check("a path segment ending in a dot or space is rejected; claims ignore trailing dots and spaces (N3-03)") {
      let codes = ["dir/movie.bin.", "dir./x.bin", "dir /x.bin", "dir/x.bin ", "dir/x.bin.part."].map { path -> String? in
        do { _ = try start(["id": "dot", "url": "http://127.0.0.1:9/x", "relativePath": path]); return nil } catch let error as EngineError { return error.code } catch { return "?" }
      }
      return codes == Array(repeating: "invalid_argument", count: 5) && get("dot") == nil
        && (try? Self.claimKey("internal", "Dir. /Movie.bin. ")) == "internal:dir/movie.bin"
    }
    try check("remove clears a tombstone and is idempotent; finished tasks are not cancelled from outside") {
      try cancelOutsideApp("p")
      try remove("p")
      try remove("p")
      try remove("never-known")
      let rejected = (try? cancelOutsideApp("done")) == nil
      queue.sync { records.removeAll(); order.removeAll(); load() }
      return rejected && list().compactMap { value($0, "id") as? String } == ["done", "c"]
        && value(get("done"), "state") as? String == DownloadStates.completed
    }
    try check("late resume data of a cancelled predecessor never reaches a new task with the same id (was REPRO N2 deferred resume)") {
      let old = FixtureTask(7)
      old.delayResumeData = true
      queue.sync {
        let generation = nextGeneration(after: 0)
        records["late"] = DownloadRecord(id: "late", url: "http://old.fixture/a", headers: [:], relativePath: "old.bin", volumeId: "internal",
          expectedBytes: 8, expectedEtag: nil, title: nil, state: DownloadStates.running, totalBytes: 8, createdAt: 0, updatedAt: 0, generation: generation)
        order.append("late")
        urlTasks["late"] = TaskRef(task: old, session: "harness.wifi", generation: generation, fromResumeData: false)
      }
      try pause("late")
      try cancel("late")
      _ = try start(["id": "late", "url": "http://new.fixture/b", "relativePath": "new.bin", "expectedBytes": 8])
      old.resumeCompletion?(Data("old URL and old partial".utf8))
      let clean = queue.sync { records["late"]?.url == "http://new.fixture/b" && loadResumeData("late") == nil && awaitingResumeData["late"] == nil }
      try cancel("late")
      return clean
    }
    queue.sync {
      listeners.removeAll()
      reconciled = true
    }
    return count
  }
}

extension OfflineDownloadEngine {
  /// N2-12 Range continuations: the append runs off the engine queue, so these checks wait outside it.
  /// N2-04 wake-up: runs outside the engine queue so the retry timer can fire.
  func wakeChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    let session = URLSession(configuration: .background(withIdentifier: "harness.wake"))
    try check("a pending retry wakes within maxWakeMs, so a sleep never delays it by the remaining wait (N2-04)") {
      var fake = 9_000_000.0
      let (production, limit) = queue.sync { (continuousMs, maxWakeMs) }
      queue.sync {
        continuousMs = { fake }
        maxWakeMs = 50
        reconciled = true
        records.removeAll(); order = ["wake"]; urlTasks.removeAll(); intents.removeAll(); probing.removeAll()
        var record = DownloadRecord(id: "wake", url: "http://127.0.0.1:39321/f/8/test", headers: [:], relativePath: "wake.bin", volumeId: "internal",
          expectedBytes: 8, expectedEtag: nil, title: nil, state: DownloadStates.retrying, totalBytes: 8, etag: nil, createdAt: 0, updatedAt: 0,
          generation: nextGeneration(after: 0))
        record.retryDue = fake + 3_600_000
        record.retryDelay = 3_600_000
        records["wake"] = record
        sessions[true] = session
        sessions[false] = session
        pump()
      }
      Thread.sleep(forTimeInterval: 0.2)
      let waiting = queue.sync { urlTasks["wake"] == nil && records["wake"]?.state == DownloadStates.retrying }
      // The device slept an hour: only the sleep-inclusive source moved, nothing calls pump().
      queue.sync { fake += 3_600_000 }
      Thread.sleep(forTimeInterval: 0.4)
      let began = queue.sync { urlTasks["wake"] != nil }
      queue.sync {
        urlTasks["wake"]?.task.cancel()
        retryTimer?.cancel()
        retryTimer = nil
        sessions.removeAll()
        records.removeAll(); order.removeAll(); urlTasks.removeAll()
        continuousMs = production
        maxWakeMs = limit
      }
      return waiting && began
    }
    return count
  }

  func continuationChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    let wifi = URLSession(configuration: .background(withIdentifier: "harness.wifi"))
    let target = try resolve("movie.bin", nil)
    func prepare(_ id: String, kept: String = "AAAA") throws -> Int {
      try queue.sync {
        reconciled = false
        records.removeAll(); order = [id]; urlTasks.removeAll(); intents.removeAll(); assembling.removeAll()
        removeKeptFiles(id)
        try? FileManager.default.removeItem(at: target)
        try Data(kept.utf8).write(to: keptFile(id))
        let generation = nextGeneration(after: 0)
        var record = DownloadRecord(id: id, url: "http://renewed.fixture/f/8/test", headers: [:], relativePath: "movie.bin", volumeId: "internal",
          expectedBytes: 8, expectedEtag: nil, title: nil, state: DownloadStates.running, totalBytes: 8, etag: "\"a\"", createdAt: 0, updatedAt: 0,
          generation: generation)
        record.keptBytes = Int64(kept.utf8.count)
        record.keptEtag = "\"a\""
        record.rangeOffset = Int64(kept.utf8.count)
        record.rangeGeneration = generation
        record.bytesWritten = Int64(kept.utf8.count)
        records[id] = record
        baseline[id] = record.bytesWritten
        return generation
      }
    }
    func finish(_ id: String, _ task: FixtureTask, body: String, generation: Int, cancelAfter: Bool = false) throws {
      let temp = supportURL.appendingPathComponent("continuation.tmp")
      try Data(body.utf8).write(to: temp)
      task.taskDescription = "\(id)#\(generation)"
      try queue.sync {
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: generation, fromResumeData: false)
        urlSession(wifi, downloadTask: task, didFinishDownloadingTo: temp)
        urlSession(wifi, task: task, didCompleteWithError: nil)
        if cancelAfter { try cancelLocked(id, tombstone: false) }
      }
    }
    func settle() {
      let until = Date().addingTimeInterval(5)
      while Date() < until, queue.sync(execute: { !assembling.isEmpty }) { Thread.sleep(forTimeInterval: 0.02) }
      queue.sync {}
    }
    func noKeptFiles(_ id: String) -> Bool {
      ((try? FileManager.default.contentsOfDirectory(atPath: keptURL.path)) ?? []).allSatisfy { $0 != id && !$0.hasPrefix(id + ".") }
    }
    try check("a Range continuation at the kept offset with the kept ETag is appended and published (N2-12)") {
      let generation = try prepare("asm")
      let task = FixtureTask(2, 206, ["Content-Range": "bytes 4-7/8", "ETag": "\"a\""], generation: generation)
      task.requestRange = "bytes=4-"
      try finish("asm", task, body: "BBBB", generation: generation)
      settle()
      return queue.sync { records["asm"]?.state } == DownloadStates.completed && (try? Data(contentsOf: target)) == Data("AAAABBBB".utf8)
        && noKeptFiles("asm") && queue.sync { records["asm"]?.keptBytes } == nil
    }
    try check("a Range continuation starting elsewhere drops the kept bytes and restarts from 0 (N2-12, N2-07)") {
      let generation = try prepare("asm")
      let task = FixtureTask(2, 206, ["Content-Range": "bytes 5-7/8", "ETag": "\"a\""], generation: generation)
      task.requestRange = "bytes=4-"
      try finish("asm", task, body: "BBB", generation: generation)
      settle()
      let record = queue.sync { records["asm"] }
      return record?.state == DownloadStates.retrying && record?.restarts == 1 && record?.bytesWritten == 0 && noKeptFiles("asm")
        && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("a Range continuation answered with another ETag drops the kept bytes (If-Range miss, N2-12)") {
      let generation = try prepare("asm")
      let task = FixtureTask(2, 206, ["Content-Range": "bytes 4-7/8", "ETag": "\"b\""], generation: generation)
      task.requestRange = "bytes=4-"
      try finish("asm", task, body: "BBBB", generation: generation)
      settle()
      return queue.sync { records["asm"]?.state } == DownloadStates.retrying && noKeptFiles("asm") && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("a 200 answer to a Range continuation is the whole new file; the kept bytes go (N2-12)") {
      let generation = try prepare("asm")
      let task = FixtureTask(2, 200, ["ETag": "\"b\"", "Content-Length": "8"], generation: generation)
      task.requestRange = "bytes=4-"
      try finish("asm", task, body: "CCCCCCCC", generation: generation)
      settle()
      let record = queue.sync { records["asm"] }
      return record?.state == DownloadStates.completed && record?.restarts == 1 && (try? Data(contentsOf: target)) == Data("CCCCCCCC".utf8) && noKeptFiles("asm")
    }
    try check("a cancel while the continuation is appended publishes nothing and leaves no kept files (N2-12)") {
      let generation = try prepare("asm")
      let task = FixtureTask(2, 206, ["Content-Range": "bytes 4-7/8", "ETag": "\"a\""], generation: generation)
      task.requestRange = "bytes=4-"
      try finish("asm", task, body: "BBBB", generation: generation, cancelAfter: true)
      Thread.sleep(forTimeInterval: 0.3)
      queue.sync {}
      return queue.sync { records["asm"] } == nil && noKeptFiles("asm") && !FileManager.default.fileExists(atPath: target.path)
    }
    try check("every terminal path deletes the kept bytes: remove of a failed task and the outside-app tombstone (N2-12)") {
      _ = try prepare("asm")
      queue.sync { records["asm"]?.state = DownloadStates.failed }
      try remove("asm")
      let removed = noKeptFiles("asm")
      _ = try prepare("asm")
      try cancelOutsideApp("asm")
      let tombstone = queue.sync { records["asm"]?.state } == DownloadStates.cancelled && noKeptFiles("asm") && queue.sync { records["asm"]?.keptBytes } == nil
      try cancel("asm")
      return removed && tombstone
    }
    queue.sync { reconciled = true }
    return count
  }
}

extension OfflineDownloadEngine {
  // Fix round 3b: a fresh GET learns its OS file through one cancel-for-resume-data and an immediate resume.
  func identityChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    let wifi = URLSession(configuration: .background(withIdentifier: "harness.wifi"))
    let id = "cyc"
    let url = "http://127.0.0.1:39321/f/4m/cyc"
    let total: Int64 = 4 << 20
    let at: Int64 = 3 << 19
    let name = "CFNetworkDownload_cyc.tmp"
    var events: [String] = []
    var lines: [String] = []
    var clock = 0.0
    let owner = NSObject()
    let (production, log) = queue.sync { (continuousMs, diagnostic) }
    queue.sync {
      continuousMs = { clock }
      diagnostic = { lines.append($0) }
      listeners[ObjectIdentifier(owner)] = (progress: { _ in }, state: { event in events.append(event["state"] as! String) })
      sessions[true] = wifi
      sessions[false] = wifi
      reconciled = true
    }
    defer {
      queue.sync {
        continuousMs = production
        diagnostic = log
        listeners.removeValue(forKey: ObjectIdentifier(owner))
        for ref in urlTasks.values { ref.task.cancel() }
        urlTasks.removeAll()
        sessions.removeAll()
        appActive = false
      }
    }
    func blob(_ bytes: Int64, etag: String = "\"a\"") -> Data {
      let info: NSDictionary = ["NSURLSessionResumeInfoTempFileName": name, "NSURLSessionResumeBytesReceived": bytes, "NSURLSessionResumeEntityTag": etag,
        "NSURLSessionDownloadURL": url]
      let archiver = NSKeyedArchiver(requiringSecureCoding: false)
      archiver.encode(info, forKey: "NSKeyedArchiveRootObjectKey")
      archiver.finishEncoding()
      return archiver.encodedData
    }
    func osFileOf(_ bytes: Int64) throws {
      try Data(repeating: 0x41, count: Int(bytes)).write(to: osDownloadsURL.appendingPathComponent(name))
    }
    func fresh(_ serial: Int, _ generation: Int) -> FixtureTask {
      let task = FixtureTask(serial, 200, ["ETag": "\"a\"", "Content-Length": "\(total)", "Accept-Ranges": "bytes"], url: url)
      task.taskDescription = "\(id)#\(generation)"
      return task
    }
    func seed(failures: Int? = nil) throws -> FixtureTask {
      try queue.sync {
        records.removeAll(); order = [id]; urlTasks.removeAll(); intents.removeAll(); awaitingResumeData.removeAll()
        for cycle in identityCycles.values { cycle.assertion.end() }
        identityCycles.removeAll()
        for assertion in assertions.values { assertion.end() }
        assertions.removeAll()
        probed.removeAll(); meters.removeAll(); baseline.removeAll()
        deleteResumeData(id)
        removeKeptFiles(id)
        clearTaskTracking(id)
        for dir in [osDownloadsURL, osTempURL] {
          for file in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] { try? FileManager.default.removeItem(at: dir.appendingPathComponent(file)) }
        }
        let generation = nextGeneration(after: 0)
        var record = DownloadRecord(id: id, url: url, headers: [:], relativePath: "cyc.bin", volumeId: "internal", expectedBytes: total, expectedEtag: nil,
          title: nil, state: DownloadStates.running, totalBytes: total, createdAt: 0, updatedAt: 0, generation: generation)
        record.identityFailures = failures
        records[id] = record
        let task = fresh(1, generation)
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: generation, fromResumeData: false)
        baseline[id] = 0
        appActive = true
        try osFileOf(at)
        task.producedResumeData = blob(at)
        events.removeAll()
        lines.removeAll()
        return task
      }
    }
    func progress(_ task: FixtureTask, _ bytes: Int64, after ms: Double) {
      queue.sync {
        clock += ms
        urlSession(wifi, downloadTask: task, didWriteData: 65536, totalBytesWritten: bytes, totalBytesExpectedToWrite: total)
      }
      queue.sync {}
    }
    /// The resumed task's first answer, as a fixture of the generation the cycle created.
    func answer(_ status: Int, _ headers: [String: String], range: String?, bytes: Int64) -> FixtureTask {
      queue.sync {
        let generation = records[id]!.generation!
        let task = FixtureTask(7, status, headers, url: url)
        task.taskDescription = "\(id)#\(generation)"
        task.requestRange = range
        urlTasks[id]?.task.cancel()
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: generation, fromResumeData: true)
        urlSession(wifi, downloadTask: task, didResumeAtOffset: at, expectedTotalBytes: total)
        urlSession(wifi, downloadTask: task, didWriteData: 65536, totalBytesWritten: bytes, totalBytesExpectedToWrite: total)
        return task
      }
    }
    func record() -> DownloadRecord? { queue.sync { records[id] } }
    func flicker() -> Bool { events.contains { [DownloadStates.paused, DownloadStates.queued, DownloadStates.retrying].contains($0) } }
    let partial = ["ETag": "\"a\"", "Content-Range": "bytes \(at)-\(total - 1)/\(total)", "Accept-Ranges": "bytes"]

    try check("a legacy path with an all-dot/space segment fails at load and owns its folder until removed (was REPRO N4, N4-03)") {
      func write(_ path: String, _ text: String) throws {
        let url = try resolve(path, nil)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
      }
      func code(_ body: () throws -> Void) -> String? {
        do { try body(); return nil } catch let error as EngineError { return error.code } catch { return "\(error)" }
      }
      let (paused, done) = queue.sync { () -> (DownloadRecord, DownloadRecord) in
        records.removeAll(); order.removeAll(); urlTasks.removeAll(); intents.removeAll()
        var paused = DownloadRecord(id: "legacy", url: url, headers: [:], relativePath: "acc/ /x.bin", volumeId: "internal", expectedBytes: 8,
          expectedEtag: nil, title: nil, state: DownloadStates.paused, totalBytes: 8, createdAt: 0, updatedAt: 0, generation: 1)
        paused.bytesWritten = 4
        let done = DownloadRecord(id: "done", url: url, headers: [:], relativePath: "acc/.../y.bin", volumeId: "internal", expectedBytes: 8,
          expectedEtag: nil, title: nil, state: DownloadStates.completed, totalBytes: 8, createdAt: 0, updatedAt: 0, generation: 1)
        records = ["legacy": paused, "done": done]
        order = ["legacy", "done"]
        persist()
        records.removeAll(); order.removeAll()
        load()
        return (records["legacy"]!, records["done"]!)
      }
      try write("acc/ /x.bin.part", "PPPP")
      try write("acc/.../y.bin", "DONE")
      let failed = [paused, done].allSatisfy { $0.state == DownloadStates.failed && $0.error?.kind == "file_system" && $0.error?.message == Self.invalidLegacyPath }
      let partial = try resolve("acc/ /x.bin.part", nil).path
      let folder = try resolve("acc", nil).path
      let guarded = code { try deletePath("acc", nil) } == "invalid_state" && code { try movePath("acc", "elsewhere", nil) } == "invalid_state"
        && code { try resume("legacy", url: nil, headers: nil) } == "invalid_argument" && FileManager.default.fileExists(atPath: partial)
      try remove("legacy")
      let stillOwned = code { try deletePath("acc", nil) } == "invalid_state"
      try remove("done")
      let freed = code { try deletePath("acc", nil) } == nil && !FileManager.default.fileExists(atPath: folder)
      return failed && guarded && stillOwned && freed
    }
    try check("clock() is monotonic and its boot id stable within the process (C2-07)") {
      let samples = (0..<2000).map { _ in OfflineDownloadEngine.clock() }
      let elapsed = samples.map { $0["elapsedMs"] as! Double }
      let ids = Set(samples.map { $0["bootId"] as! String })
      return zip(elapsed, elapsed.dropFirst()).allSatisfy { $0 <= $1 } && ids.count == 1 && !(ids.first ?? "").isEmpty
        && abs(elapsed.last! - OfflineDownloadEngine.continuousNow()) < 1000
    }
    try check("a fresh GET is cycled once: validated and >= 256 KiB in, no time minimum; identity recorded, no state event, no restart (3b, D-03)") {
      let task = try seed()
      let first = record()!.generation!
      let threshold: Int64 = 256 << 10
      task.producedResumeData = blob(threshold)
      progress(task, threshold - 1, after: 0)
      let small = task.cancels == 0
      progress(task, threshold, after: 0)
      let cycled = record()!
      let ref = queue.sync { urlTasks[id] }
      // The old task's cancellation arrives late: it is stale and changes nothing.
      queue.sync {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSURLSessionDownloadTaskResumeData: blob(threshold)])
        urlSession(wifi, task: task, didCompleteWithError: error)
      }
      let after = record()!
      return small && task.cancels == 1 && ref?.fromResumeData == true && cycled.generation! > first
        && cycled.osFileName == name && cycled.osFileGeneration == cycled.generation && queue.sync { osFiles[id] } == name
        && after.generation == cycled.generation && after.restarts == 0 && after.bytesWritten == threshold && after.keptBytes == threshold
        && after.state == DownloadStates.running && !flicker() && queue.sync { identityCycles.isEmpty && intents[id] == nil }
    }
    try check("the resumed 206 confirms the identity (one log line with the cost); the named file is kept as it grows (3b)") {
      let task = answer(206, partial, range: "bytes=\(at)-", bytes: at + (1 << 19))
      try osFileOf(at + (1 << 19))
      let kept = queue.sync { snapshot(id) }
      let current = record()!
      return task.cancels == 0 && current.validatedGeneration == current.generation && current.osFileName == name && kept
        && current.keptBytes == at + (1 << 19) && lines.filter { $0.contains("identity cycle: \(name) at") && $0.contains("resumed with a 206 after") }.count == 1
    }
    try check("an OS retry inside the cycled task that its own Range cannot prove keeps the kept bytes, no restart (3b)") {
      let stale = answer(206, partial, range: "bytes=\(at)-", bytes: at + (1 << 19))
      try osFileOf(at + (1 << 19))
      _ = queue.sync { snapshot(id) }
      let keptBefore = record()!.keptBytes
      let retry = FixtureTask(7, 206, ["ETag": "\"a\"", "Content-Range": "bytes 3000000-\(total - 1)/\(total)"], url: url)
      retry.taskDescription = stale.taskDescription
      retry.requestRange = "bytes=\(at)-"
      let generation = record()!.generation!
      queue.sync {
        urlTasks[id] = TaskRef(task: retry, session: "harness.wifi", generation: generation, fromResumeData: true)
        urlSession(wifi, downloadTask: retry, didWriteData: 65536, totalBytesWritten: 3000000 + 65536, totalBytesExpectedToWrite: total)
        urlSession(wifi, task: retry, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost))
      }
      let failed = record()!
      return retry.cancels == 1 && keptBefore == at + (1 << 19) && failed.keptBytes == keptBefore && failed.bytesWritten == keptBefore
        && failed.restarts == 0 && failed.state == DownloadStates.retrying && failed.error?.message.contains("unverifiable") == true
    }
    try check("an OS retry whose own Range matches its Content-Range continues inside the task (3b)") {
      let task = try seed()
      progress(task, at, after: 2500)
      _ = answer(206, partial, range: "bytes=\(at)-", bytes: at + 65536)
      let retry = FixtureTask(7, 206, ["ETag": "\"a\"", "Content-Range": "bytes 3000000-\(total - 1)/\(total)"], url: url)
      let generation = record()!.generation!
      retry.taskDescription = "\(id)#\(generation)"
      retry.requestRange = "bytes=3000000-"
      queue.sync {
        urlTasks[id] = TaskRef(task: retry, session: "harness.wifi", generation: generation, fromResumeData: true)
        urlSession(wifi, downloadTask: retry, didWriteData: 65536, totalBytesWritten: 3000000 + 65536, totalBytesExpectedToWrite: total)
      }
      return retry.cancels == 0 && record()!.state == DownloadStates.running && record()!.bytesWritten == 3000000 + 65536
    }
    try check("a resumed task answered 200 or with another ETag gets no identity and counts one failure (3b)") {
      let task = try seed()
      progress(task, at, after: 2500)
      _ = answer(200, ["ETag": "\"a\"", "Content-Length": "\(total)", "Accept-Ranges": "bytes"], range: "bytes=\(at)-", bytes: 65536)
      let whole = record()!
      let other = try seed()
      progress(other, at, after: 2500)
      let changed = answer(206, ["ETag": "\"b\"", "Content-Range": "bytes \(at)-\(total - 1)/\(total)"], range: "bytes=\(at)-", bytes: at + 65536)
      let etag = record()!
      return whole.osFileName == nil && whole.identityFailures == 1 && queue.sync { osFiles[id] } == nil && whole.restarts == 1
        && etag.osFileName == nil && etag.identityFailures == 1 && changed.cancels == 1
        && lines.filter { $0.contains("identity cycle failed") }.count == 1
    }
    try check("no resume data: one honest restart per failure, at most two failed cycles, then never again (3b)") {
      var task = try seed()
      var cancels = 0
      for round in 0..<3 {
        task.producedResumeData = nil
        progress(task, at, after: 2500)
        cancels += task.cancels
        let generation = record()!.generation!
        if round < 2 {
          task = fresh(10 + round, generation)
          queue.sync {
            urlTasks[id]?.task.cancel()
            urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: generation, fromResumeData: false)
          }
        }
      }
      let current = record()!
      return cancels == 2 && current.identityFailures == 2 && current.restarts == 2 && current.state == DownloadStates.running
        && lines.filter { $0.contains("identity cycle failed (no resume data)") }.count == 2 && queue.sync { intents[id] == nil }
    }
    try check("no cycle in the background; it runs at the next activation (3b)") {
      let task = try seed()
      queue.sync { appActive = false }
      progress(task, at, after: 2500)
      let waited = task.cancels == 0
      queue.sync { setAppActive(true) }
      queue.sync {}
      return waited && task.cancels == 1 && record()!.osFileName == name
    }
    try check("the old task ending before its resume data arrives changes nothing visible, and its slot stays taken (3b)") {
      let task = try seed()
      task.delayResumeData = true
      queue.sync {
        settings.maxConcurrent = 1
        records["other"] = DownloadRecord(id: "other", url: url, headers: [:], relativePath: "other.bin", volumeId: "internal", expectedBytes: total,
          expectedEtag: nil, title: nil, state: DownloadStates.queued, createdAt: 1, updatedAt: 1, generation: nil)
        order.append("other")
      }
      progress(task, at, after: 2500)
      queue.sync {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSURLSessionDownloadTaskResumeData: blob(at)])
        urlSession(wifi, task: task, didCompleteWithError: error)
        pump()
      }
      let gap = queue.sync { urlTasks["other"] == nil && urlTasks[id] == nil && records[id]?.state == DownloadStates.running }
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {}
      let resumed = record()!
      queue.sync {
        records.removeValue(forKey: "other")
        order.removeAll { $0 == "other" }
        settings.maxConcurrent = 2
      }
      return gap && queue.sync { urlTasks[id]?.fromResumeData == true && urlTasks["other"] == nil } && resumed.osFileName == name
        && resumed.restarts == 0 && resumed.bytesWritten == at && !flicker()
    }
    try check("a pause during the cycle keeps the blob for its resume and starts nothing (3b)") {
      let task = try seed()
      task.delayResumeData = true
      progress(task, at, after: 2500)
      try pause(id)
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: [NSURLSessionDownloadTaskResumeData: blob(at)])
        urlSession(wifi, task: task, didCompleteWithError: error)
      }
      let paused = record()!
      return task.cancels == 1 && paused.state == DownloadStates.paused && queue.sync { urlTasks[id] == nil && loadResumeData(id) != nil && identityCycles.isEmpty }
        && events == [DownloadStates.paused]
    }
    try check("bytes that cannot continue count one restart on every path, never two (D-02)") {
      // DL-C2: a 403 left 2,407,796 recorded bytes without resume data or kept bytes; the renew started over.
      _ = try seed()
      queue.sync {
        urlTasks.removeAll()
        deleteResumeData(id)
        records[id]?.state = DownloadStates.failed
        records[id]?.bytesWritten = 2_407_796
        records[id]?.error = DownloadErrorInfo(kind: "http", message: "HTTP 403", httpStatus: 403)
      }
      try resume(id, url: url + "?renewed", headers: nil)
      let renewed = record()!
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      // A 416 drops the bytes once; the resume that follows starts from 0 without counting again.
      _ = try seed()
      queue.sync {
        records[id]?.bytesWritten = 1_000
        handle(id, Failure(error: DownloadErrorInfo(kind: "http", message: "HTTP 416", httpStatus: 416), retryable: false, dropPartial: true))
        urlTasks.removeAll()
      }
      let dropped = record()!
      try resume(id, url: nil, headers: nil)
      let again = record()!
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      return renewed.restarts == 1 && renewed.bytesWritten == 0 && renewed.state == DownloadStates.running
        && dropped.restarts == 1 && dropped.bytesWritten == 0 && dropped.state == DownloadStates.failed
        && again.restarts == 1 && again.bytesWritten == 0
    }
    try check("a pause reaches disk only together with its resume data and kept bytes (D-01)") {
      let task = try seed()
      task.delayResumeData = true
      func persisted() -> String? {
        let json = (try? JSONSerialization.jsonObject(with: Data(contentsOf: stateURL))) as? [String: Any]
        return (json?["tasks"] as? [[String: Any]])?.first { $0["id"] as? String == id }?["state"] as? String
      }
      try pause(id)
      let early = persisted()
      let inMemory = record()?.state
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {}
      let late = persisted()
      let kept = queue.sync { loadResumeData(id) != nil && records[id]?.keptBytes == at && (try? Data(contentsOf: keptFile(id)).count) == Int(at) }
      return early == DownloadStates.running && inMemory == DownloadStates.paused && late == DownloadStates.paused && kept
    }
    try check("an in-task 206 is this task's continuation only when it starts at the bytes the same task reported (D-03)") {
      // DL-C1: a reset in the first response before the cycle; nsurlsessiond's own Range never shows on currentRequest.
      func cut(_ task: FixtureTask, start: Int64, etag: String = "\"a\"") {
        task.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 206, httpVersion: "HTTP/1.1",
          headerFields: ["ETag": etag, "Content-Range": "bytes \(start)-\(total - 1)/\(total)"])!
      }
      func reportedBeforeCut() throws -> FixtureTask {
        let task = try seed()
        queue.sync { appActive = false }
        progress(task, at, after: 10)
        return task
      }
      // Accepted: the same task continues exactly at what it reported.
      var task = try reportedBeforeCut()
      cut(task, start: at)
      progress(task, at + 65536, after: 10)
      let continued = record()!
      let running = queue.sync { urlTasks[id] != nil && intents[id] == nil }
      let proven = lines.contains { $0.contains("in-task continuation at \(at) proven") }
      let temp = supportURL.appendingPathComponent("d03.tmp")
      try Data(repeating: 0x41, count: Int(total)).write(to: temp)
      queue.sync {
        urlSession(wifi, downloadTask: task, didFinishDownloadingTo: temp)
        urlSession(wifi, task: task, didCompleteWithError: nil)
      }
      let published = record()!
      try? FileManager.default.removeItem(at: try resolve("cyc.bin", nil))
      // Not accepted: a start past the reported bytes, another ETag, another task of the same generation.
      func rejected(_ start: Int64, etag: String = "\"a\"", otherTask: Bool = false) throws -> Failure? {
        let task = try reportedBeforeCut()
        let generation = record()!.generation!
        let answer = otherTask ? fresh(9, generation) : task
        cut(answer, start: start, etag: etag)
        return queue.sync {
          var copy = records[id]!
          return validate(answer, generation: generation, record: &copy, validatedKey: responseKeys[id])
        }
      }
      let ahead = try rejected(at + 1)
      let otherEtag = try rejected(at, etag: "\"b\"")
      let otherTask = try rejected(at, otherTask: true)
      return continued.state == DownloadStates.running && continued.bytesWritten == at + 65536 && continued.restarts == 0 && running && proven
        && published.state == DownloadStates.completed && published.restarts == 0
        && ahead?.unverified == true && otherEtag != nil && otherEtag?.unverified == false && otherTask?.unverified == true
    }
    /// The OS retried inside the task: its response becomes a 206 whose own Range the app never sees (D-03).
    func inTask206(_ task: FixtureTask, start: Int64, etag: String = "\"a\"") {
      task.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 206, httpVersion: "HTTP/1.1",
        headerFields: ["ETag": etag, "Content-Range": "bytes \(start)-\(total - 1)/\(total)", "Accept-Ranges": "bytes"])!
    }
    func finishWhole(_ task: FixtureTask) throws {
      let temp = supportURL.appendingPathComponent("n6.tmp")
      try Data(repeating: 0x41, count: Int(total)).write(to: temp)
      queue.sync {
        urlSession(wifi, downloadTask: task, didFinishDownloadingTo: temp)
        urlSession(wifi, task: task, didCompleteWithError: nil)
      }
      queue.sync {}
    }
    func publishedSize() -> Int64? { (try? FileManager.default.attributesOfItem(atPath: try resolve("cyc.bin", nil).path)[.size] as? NSNumber)?.int64Value }
    try check("a file finishing before any report of its in-task 206 is judged by the report from before the cut (was REPRO N6, N6-01)") {
      func run(reportAfterCut: Bool, start: Int64) throws -> (DownloadRecord, Int64?) {
        let task = try seed()
        queue.sync { appActive = false }
        progress(task, at, after: 10)
        inTask206(task, start: start)
        if reportAfterCut { progress(task, at + 65536, after: 10) }
        try finishWhole(task)
        let result = (record()!, publishedSize())
        try? FileManager.default.removeItem(at: try resolve("cyc.bin", nil))
        return result
      }
      let (tail, tailFile) = try run(reportAfterCut: false, start: at)
      let (control, controlFile) = try run(reportAfterCut: true, start: at)
      let (elsewhere, elsewhereFile) = try run(reportAfterCut: false, start: at + 1)
      return tail.state == DownloadStates.completed && tail.restarts == 0 && tailFile == total
        && control.state == DownloadStates.completed && control.restarts == 0 && controlFile == total
        && elsewhere.state != DownloadStates.completed && elsewhereFile == nil
    }
    try check("a report of the same task identifier under another generation never proves an answer (verifier round 6 check 6)") {
      let task = try seed()
      queue.sync { appActive = false }
      progress(task, at, after: 10)
      let stale = queue.sync { () -> Failure? in
        let generation = nextGeneration(after: records[id]!.generation!)
        records[id]!.generation = generation
        records[id]!.validatedGeneration = generation
        let other = fresh(1, generation)
        responseKeys[id] = "\(generation) 200  \"a\""
        inTask206(other, start: at)
        var copy = records[id]!
        return validate(other, generation: generation, record: &copy, validatedKey: responseKeys[id])
      }
      return task.taskIdentifier == 1 && stale?.unverified == true
    }
    try check("a task from resume data keeps its blob's stale Range; an in-task 206 at its report still continues it (N6-04)") {
      // Device: cycled at 262144, paused and resumed at 6,257,960, reset 64 KiB before the end; currentRequest still says 262144-.
      let cut: Int64 = total - 65536
      /// Cycled (a new generation from its blob), validated at its resume offset, reported up to `cut`; Range stays stale.
      func resumed(staleRange: String) throws -> FixtureTask {
        let task = try seed()
        progress(task, at, after: 10)
        let stale = answer(206, partial, range: staleRange, bytes: cut)
        queue.sync { appActive = false }
        lines.removeAll(); events.removeAll()
        _ = task
        return stale
      }
      // Accepted: visible Range behind the report, 206 starting exactly at the report.
      let task = try resumed(staleRange: "bytes=262144-")
      inTask206(task, start: cut)
      progress(task, total - 4096, after: 10)
      let continued = record()!
      let accepted = queue.sync { urlTasks[id]?.task === task } && continued.state == DownloadStates.running && continued.restarts == 0
        && continued.bytesWritten == total - 4096 && !flicker() && lines.contains { $0.contains("in-task continuation at \(cut) proven") }
      func judged(staleRange: String, start: Int64, staleGeneration: Bool = false) throws -> Failure? {
        let task = try resumed(staleRange: staleRange)
        inTask206(task, start: start)
        return queue.sync { () -> Failure? in
          var copy = records[id]!
          let generation = copy.generation!
          let report = staleGeneration ? lastReport[id].map { ($0.task, $0.generation - 1, $0.bytes) } : lastReport[id]
          return validate(task, generation: generation, record: &copy, validatedKey: responseKeys[id], report: report)
        }
      }
      // A visible Range ahead of the report is a real continuation request: today's rule (start must equal it).
      let ahead = try judged(staleRange: "bytes=\(cut + 4096)-", start: cut)
      let aheadMatching = try judged(staleRange: "bytes=\(cut + 4096)-", start: cut + 4096)
      let elsewhere = try judged(staleRange: "bytes=262144-", start: cut + 1)
      // A 206 at the stale Range itself is no continuation of a file that holds `cut` bytes.
      let atStale = try judged(staleRange: "bytes=262144-", start: 262144)
      let otherGeneration = try judged(staleRange: "bytes=262144-", start: cut, staleGeneration: true)
      return accepted && ahead != nil && aheadMatching == nil && elsewhere != nil && otherGeneration != nil && atStale != nil
    }
    try check("a fresh GET continued in-task (D-03) is still cycled past 256 KiB; a later in-task 410 keeps the bytes (was REPRO N6, N6-02)") {
      let kib: Int64 = 1024
      let task = try seed()
      progress(task, 100 * kib, after: 10)
      inTask206(task, start: 100 * kib)
      progress(task, 164 * kib, after: 10)
      let continued = task.cancels == 0 && record()!.restarts == 0 && queue.sync { urlTasks[id]?.task === task }
      progress(task, at, after: 10)
      let cycled = task.cancels == 1 && queue.sync { urlTasks[id]?.fromResumeData == true }
      _ = answer(206, partial, range: "bytes=\(at)-", bytes: at + 65536)
      let identified = record()!.osFileName == name && record()!.keptBytes == at
      // The OS retries inside the resumed task, gets 410 and keeps an error body: the kept bytes stay.
      let resumed = queue.sync { urlTasks[id]!.task as! FixtureTask }
      resumed.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 410, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "28"])!
      queue.sync {
        urlSession(wifi, downloadTask: resumed, didWriteData: 28, totalBytesWritten: 28, totalBytesExpectedToWrite: 28)
        urlSession(wifi, task: resumed, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      queue.sync {}
      let failed = record()!
      // A 200 without Accept-Ranges is no fresh GET to cycle, also after a proven in-task 206.
      let plain = try seed()
      plain.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["ETag": "\"a\"", "Content-Length": "\(total)"])!
      progress(plain, 100 * kib, after: 10)
      inTask206(plain, start: 100 * kib)
      progress(plain, at, after: 10)
      let notCycled = plain.cancels == 0 && record()!.osFileName == nil && record()!.state == DownloadStates.running
      return continued && cycled && identified && failed.state == DownloadStates.failed && failed.error?.httpStatus == 410
        && failed.bytesWritten == at && failed.keptBytes == at && failed.restarts == 0 && notCycled
    }
    /// The engine's own Range continuation after `kept` bytes (a renewed URL, an in-task 4xx), as begin() makes it.
    var ownSerial = 300
    func ownTask(kept: Int64, active: Bool = false, visible: Int64? = nil) throws -> FixtureTask {
      _ = try seed()
      return try queue.sync {
        for ref in urlTasks.values { ref.task.cancel() }
        urlTasks.removeAll()
        appActive = active
        ownSerial += 1
        var record = records[id]!
        let generation = nextGeneration(after: record.generation!)
        try Data(repeating: 0x4B, count: Int(kept)).write(to: keptFile(id))
        record.generation = generation
        record.keptBytes = kept
        record.keptEtag = "\"a\""
        record.etag = "\"a\""
        record.rangeOffset = kept
        record.rangeGeneration = generation
        record.bytesWritten = kept
        records[id] = record
        let task = FixtureTask(ownSerial, 206, ["ETag": "\"a\"", "Content-Range": "bytes \(kept)-\(total - 1)/\(total)", "Accept-Ranges": "bytes"], url: url)
        task.taskDescription = "\(id)#\(generation)"
        task.requestRange = "bytes=\(visible ?? kept)-"
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: generation, fromResumeData: false)
        baseline[id] = kept
        events.removeAll()
        lines.removeAll()
        return task
      }
    }
    func waitFolded() {
      let until = Date().addingTimeInterval(5)
      while Date() < until, queue.sync(execute: { folding.contains(id) || !assembling.isEmpty }) { Thread.sleep(forTimeInterval: 0.02) }
      queue.sync {}
    }
    try check("an in-task 206 at the end of the engine's own Range continuation continues it (was REPRO N7, N7-01)") {
      let kept: Int64 = 1 << 20
      let relative: Int64 = 2 << 20
      // Control (verifier): a task from resume data with the same numbers continues in-task at its report (N6-04).
      let control = try seed()
      queue.sync { appActive = false }
      progress(control, at, after: 10)
      let resumed = answer(206, partial, range: "bytes=\(at)-", bytes: kept + relative)
      inTask206(resumed, start: kept + relative)
      progress(resumed, kept + relative + 65536, after: 10)
      let controlContinued = queue.sync { urlTasks[id]?.task === resumed } && record()!.restarts == 0
      // The own continuation: 1 MiB kept, 2 MiB of this request reported (3 MiB in all), then the in-task 206 at 3 MiB.
      let own = try ownTask(kept: kept)
      progress(own, relative, after: 10)
      inTask206(own, start: kept + relative)
      progress(own, relative + 65536, after: 10)
      let continued = record()!
      let running = queue.sync { urlTasks[id]?.task === own && intents[id] == nil }
      let proven = lines.contains { $0.contains("in-task continuation at \(kept + relative) proven") }
      // The OS file holds the bytes after the kept ones; the finish appends them and publishes.
      let temp = supportURL.appendingPathComponent("n7.tmp")
      try Data(repeating: 0x41, count: Int(total - kept)).write(to: temp)
      queue.sync {
        urlSession(wifi, downloadTask: own, didFinishDownloadingTo: temp)
        urlSession(wifi, task: own, didCompleteWithError: nil)
      }
      waitFolded()
      let published = record()!
      let size = publishedSize()
      try? FileManager.default.removeItem(at: try resolve("cyc.bin", nil))
      return controlContinued && running && proven && continued.state == DownloadStates.running && continued.restarts == 0
        && continued.bytesWritten == kept + relative + 65536 && !flicker()
        && published.state == DownloadStates.completed && published.restarts == 0 && size == total
    }
    try check("an own continuation's in-task 206 is not proven by another start, ETag, generation or task; a Range ahead keeps its rule (N7-01)") {
      let kept: Int64 = 1 << 20
      let relative: Int64 = 2 << 20
      func judged(start: Int64, etag: String = "\"a\"", visible: Int64? = nil, report: ((task: Int, generation: Int, bytes: Int64)) -> (task: Int, generation: Int, bytes: Int64)? = { $0 }) throws -> Failure? {
        let own = try ownTask(kept: kept, visible: visible)
        progress(own, relative, after: 10)
        inTask206(own, start: start, etag: etag)
        return queue.sync { () -> Failure? in
          var copy = records[id]!
          return validate(own, generation: copy.generation!, record: &copy, validatedKey: responseKeys[id], report: lastReport[id].flatMap(report))
        }
      }
      let accepted = try judged(start: kept + relative)
      let elsewhere = try judged(start: kept + relative + 1)
      let relativeOnly = try judged(start: relative)
      let otherEtag = try judged(start: kept + relative, etag: "\"b\"")
      let beforeContinuation = try judged(start: kept + relative) { ($0.task, $0.generation - 1, $0.bytes) }
      let otherTask = try judged(start: kept + relative) { ($0.task + 1, $0.generation, $0.bytes) }
      let ahead = try judged(start: kept + relative, visible: kept + relative + 4096)
      let aheadMatching = try judged(start: kept + relative + 4096, visible: kept + relative + 4096)
      return accepted == nil && elsewhere?.unverified == true && relativeOnly != nil && otherEtag != nil && otherEtag?.unverified == false
        && beforeContinuation?.unverified == true && otherTask?.unverified == true && ahead != nil && aheadMatching == nil
    }
    try check("an own continuation is cycled after 256 KiB; its snapshots survive a later in-task 410 and a renew continues after them (N7-01)") {
      let kept: Int64 = 1 << 20
      let first: Int64 = 512 << 10
      let own = try ownTask(kept: kept, active: true)
      // Its blob names the OS file of the bytes after the kept ones (0x41 here; the kept bytes are 0x4B).
      try Data(repeating: 0x41, count: Int(first)).write(to: osDownloadsURL.appendingPathComponent(name))
      own.producedResumeData = blob(first)
      progress(own, 128 << 10, after: 10)
      let notYet = own.cancels == 0
      progress(own, first, after: 10)
      let cycled = record()!
      let resumedGeneration = cycled.generation!
      let fromBlob = queue.sync { urlTasks[id]?.fromResumeData == true }
      let snapAtCycle = cycled.keptTailBytes == first && (try? Data(contentsOf: snapFile(id))) == Data(repeating: 0x41, count: Int(first))
      // The resumed task continues after the blob's bytes: its first answer must start at kept + first.
      let resumed = queue.sync { () -> FixtureTask in
        let task = FixtureTask(ownSerial + 100, 206, ["ETag": "\"a\"", "Content-Range": "bytes \(kept + first)-\(total - 1)/\(total)"], url: url)
        task.taskDescription = "\(id)#\(resumedGeneration)"
        task.requestRange = "bytes=\(kept)-"
        urlTasks[id]?.task.cancel()
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: resumedGeneration, fromResumeData: true)
        urlSession(wifi, downloadTask: task, didResumeAtOffset: first, expectedTotalBytes: total - kept)
        urlSession(wifi, downloadTask: task, didWriteData: 65536, totalBytesWritten: first + 65536, totalBytesExpectedToWrite: total - kept)
        return task
      }
      let identified = record()!.osFileName == name && record()!.rangeOffset == kept && record()!.bytesWritten == kept + first + 65536
        && lines.contains { $0.contains("identity cycle: \(name) at \(kept + first) bytes") }
      let quiet = !flicker()
      // A later snapshot of the grown OS file, then the OS retries in the task, gets 410 and truncates its file.
      let grown: Int64 = first + (256 << 10)
      try Data(repeating: 0x41, count: Int(grown)).write(to: osDownloadsURL.appendingPathComponent(name))
      queue.sync {
        urlSession(wifi, downloadTask: resumed, didWriteData: 65536, totalBytesWritten: grown, totalBytesExpectedToWrite: total - kept)
        _ = snapshot(id)
      }
      let snapped = record()!.keptTailBytes == grown
      try Data("{\"code\":\"capability_revoked\"}".utf8).write(to: osDownloadsURL.appendingPathComponent(name))
      resumed.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 410, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "28"])!
      queue.sync {
        urlSession(wifi, downloadTask: resumed, didWriteData: 28, totalBytesWritten: 28, totalBytesExpectedToWrite: 28)
        urlSession(wifi, task: resumed, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      queue.sync {}
      let failed = record()!
      // A renewed URL folds the snapshot into the kept bytes first, then continues right after them.
      try resume(id, url: url + "?renewed", headers: nil)
      waitFolded()
      let renewed = record()!
      let request = queue.sync { urlTasks[id]?.task.currentRequest }
      let keptData = (try? Data(contentsOf: keptFile(id))) ?? Data()
      let joined = keptData == Data(repeating: 0x4B, count: Int(kept)) + Data(repeating: 0x41, count: Int(grown))
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      return notYet && own.cancels == 1 && fromBlob && snapAtCycle && identified && quiet && snapped
        && failed.state == DownloadStates.failed && failed.error?.httpStatus == 410 && failed.bytesWritten == kept + grown && failed.restarts == 0
        && renewed.keptBytes == kept + grown && renewed.keptTailBytes == nil && renewed.rangeOffset == kept + grown && renewed.restarts == 0
        && request?.value(forHTTPHeaderField: "Range") == "bytes=\(kept + grown)-" && joined
        && !FileManager.default.fileExists(atPath: snapFile(id).path)
    }
    try check("the snapshot an own continuation's cycle takes is bound to the resumed task: an in-task 410 right after the resume keeps it (N8-01)") {
      let kept: Int64 = 1 << 20
      let first: Int64 = 512 << 10
      let own = try ownTask(kept: kept, active: true)
      try Data(repeating: 0x41, count: Int(first)).write(to: osDownloadsURL.appendingPathComponent(name))
      own.producedResumeData = blob(first)
      progress(own, 128 << 10, after: 10)
      progress(own, first, after: 10)
      let cycled = record()!
      let resumed = queue.sync { () -> FixtureTask in
        let task = FixtureTask(ownSerial + 200, 206, ["ETag": "\"a\"", "Content-Range": "bytes \(kept + first)-\(total - 1)/\(total)"], url: url)
        task.taskDescription = "\(id)#\(cycled.generation!)"
        task.requestRange = "bytes=\(kept)-"
        urlTasks[id]?.task.cancel()
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: cycled.generation!, fromResumeData: true)
        urlSession(wifi, downloadTask: task, didResumeAtOffset: first, expectedTotalBytes: total - kept)
        return task
      }
      try Data("{}".utf8).write(to: osDownloadsURL.appendingPathComponent(name))
      resumed.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 410, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "2"])!
      queue.sync {
        urlSession(wifi, downloadTask: resumed, didWriteData: 2, totalBytesWritten: 2, totalBytesExpectedToWrite: 2)
        urlSession(wifi, task: resumed, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      queue.sync {}
      let failed = record()!
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      return cycled.tailBase == TailBase(offset: kept, etag: "\"a\"", generation: cycled.generation!) && cycled.rangeGeneration == cycled.generation
        && failed.state == DownloadStates.failed && failed.bytesWritten == kept + first && failed.keptTailBytes == first
    }
    try check("an own continuation whose cycle gets no resume data continues from its kept bytes: one failure, no restart (N7-01)") {
      let kept: Int64 = 1 << 20
      let own = try ownTask(kept: kept, active: true)
      own.producedResumeData = nil
      progress(own, 512 << 10, after: 10)
      let after = record()!
      let request = queue.sync { urlTasks[id]?.task.currentRequest }
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      // A blob of another ETag names no file of these bytes: the same fallback.
      let other = try ownTask(kept: kept, active: true)
      try Data(repeating: 0x41, count: 512 << 10).write(to: osDownloadsURL.appendingPathComponent(name))
      other.producedResumeData = blob(512 << 10, etag: "\"b\"")
      progress(other, 512 << 10, after: 10)
      let foreign = record()!
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      // Near the end (under 1 MiB left after the kept bytes) an own continuation is not cycled.
      let late = try ownTask(kept: total - (1 << 20), active: true)
      progress(late, 256 << 10, after: 10)
      let notCycled = late.cancels == 0
      return own.cancels == 1 && after.identityFailures == 1 && after.restarts == 0 && after.bytesWritten == kept && after.osFileName == nil
        && request?.value(forHTTPHeaderField: "Range") == "bytes=\(kept)-" && !flicker()
        && other.cancels == 1 && foreign.identityFailures == 1 && foreign.keptTailBytes == nil && foreign.bytesWritten == kept && notCycled
    }
    try check("a new URL during an own continuation's cycle continues after the blob's bytes with the new URL, not the blob (N7-01)") {
      let kept: Int64 = 1 << 20
      let first: Int64 = 512 << 10
      let own = try ownTask(kept: kept, active: true)
      try Data(repeating: 0x41, count: Int(first)).write(to: osDownloadsURL.appendingPathComponent(name))
      own.delayResumeData = true
      progress(own, first, after: 10)
      let renewed = url + "?renewed"
      try resume(id, url: renewed, headers: nil)
      queue.sync { own.resumeCompletion?(blob(first)) }
      queue.sync {
        urlSession(wifi, task: own, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      waitFolded()
      let next = queue.sync { urlTasks[id] }
      let current = record()!
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      return next?.fromResumeData == false && next?.task.currentRequest?.url?.absoluteString == renewed
        && next?.task.currentRequest?.value(forHTTPHeaderField: "Range") == "bytes=\(kept + first)-"
        && current.keptBytes == kept + first && current.restarts == 0 && current.state == DownloadStates.running
    }
    try check("a pause during an own continuation's cycle keeps the blob's bytes as its snapshot and starts nothing (N7-01)") {
      let kept: Int64 = 1 << 20
      let first: Int64 = 512 << 10
      let own = try ownTask(kept: kept, active: true)
      try Data(repeating: 0x41, count: Int(first)).write(to: osDownloadsURL.appendingPathComponent(name))
      own.delayResumeData = true
      progress(own, first, after: 10)
      try pause(id)
      queue.sync { own.resumeCompletion?(blob(first)) }
      queue.sync {
        urlSession(wifi, task: own, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      queue.sync {}
      let paused = record()!
      let idle = queue.sync { urlTasks[id] == nil && loadResumeData(id) == nil && identityCycles.isEmpty }
      try resume(id, url: nil, headers: nil)
      waitFolded()
      let resumed = record()!
      let request = queue.sync { urlTasks[id]?.task.currentRequest }
      queue.sync { urlTasks[id]?.task.cancel(); urlTasks.removeAll() }
      return paused.state == DownloadStates.paused && paused.keptTailBytes == first && paused.restarts == 0 && idle
        && resumed.keptBytes == kept + first && request?.value(forHTTPHeaderField: "Range") == "bytes=\(kept + first)-" && resumed.restarts == 0
    }
    try check("every identity cycle ends its background time exactly once, at once when the file finishes inside it (was REPRO N5, N5-03)") {
      func open() -> Int { let balance = BackgroundAssertion.balance; return balance.begun - balance.ended }
      func cycling(_ task: FixtureTask) {
        task.delayResumeData = true
        progress(task, at, after: 2500)
      }
      let start = BackgroundAssertion.balance
      // The file finishes before the cancel for the resume data took effect (the verifier's race).
      var task = try seed()
      cycling(task)
      let duringRace = open()
      let temp = supportURL.appendingPathComponent("n5-finished.tmp")
      try Data(repeating: 0x41, count: Int(total)).write(to: temp)
      queue.sync {
        urlSession(wifi, downloadTask: task, didFinishDownloadingTo: temp)
        urlSession(wifi, task: task, didCompleteWithError: nil)
      }
      let afterFinish = open()
      let published = record()?.state == DownloadStates.completed
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {}
      let afterLateBlob = open()
      try? FileManager.default.removeItem(at: try resolve("cyc.bin", nil))
      // A cancel during the cycle ends it with the record; the late blob changes nothing.
      task = try seed()
      cycling(task)
      try cancel(id)
      let afterCancel = open()
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {}
      // A pause keeps the cycle until its blob is saved, then ends it once.
      task = try seed()
      cycling(task)
      try pause(id)
      let pausedOpen = open()
      queue.sync { task.resumeCompletion?(blob(at)) }
      queue.sync {}
      let afterPause = open()
      // The normal cycle and one whose resume data is unusable end theirs when the next task runs.
      task = try seed()
      progress(task, at, after: 2500)
      let afterSuccess = open()
      task = try seed()
      task.producedResumeData = nil
      progress(task, at, after: 2500)
      let afterFailure = open()
      // The expiry handler and a normal end may both reach one assertion: it is still ended once.
      let twice = BackgroundAssertion("n5-twice") {}
      twice.end()
      twice.end()
      let end = BackgroundAssertion.balance
      return duringRace == 1 && afterFinish == 0 && published && afterLateBlob == 0 && afterCancel == 0 && pausedOpen == 1 && afterPause == 0
        && afterSuccess == 0 && afterFailure == 0 && end.begun - start.begun == 6 && end.ended - start.ended == 6
    }
    try check("the identity survives a relaunch while its file exists and is dropped when it is gone (3b)") {
      let task = try seed()
      progress(task, at, after: 2500)
      let generation = record()!.generation!
      func relaunch() -> String? {
        queue.sync {
          persist()
          records.removeAll(); order.removeAll(); urlTasks.removeAll(); clearTaskTracking(id)
          load()
          let adopted = fresh(20, generation)
          adopt(id, adopted, wifi)
          return osFiles[id]
        }
      }
      let kept = relaunch()
      try FileManager.default.removeItem(at: osDownloadsURL.appendingPathComponent(name))
      let gone = relaunch()
      return kept == name && gone == nil && record()?.osFileName == nil && task.cancels == 1
    }
    return count
  }
}

@main enum EngineHostCheck {
  static func main() throws {
    setvbuf(stdout, nil, _IOLBF, 0)
    let engine = OfflineDownloadEngine.shared
    let count = try engine.queue.sync { try engine.hostChecks() } + engine.tombstoneChecks() + engine.continuationChecks() + engine.wakeChecks()
      + engine.identityChecks() + engine.tailBindingChecks()
    print("Swift engine host: \(count)/\(count) checks passed")
  }
}

extension OfflineDownloadEngine {
  /// Fix round 3g: a tail snapshot extends only the kept bytes it was taken after (N8-01); an interrupted append costs at
  /// most that append (N8-02); a directory is never a download target (N8-03). Ports verifier round 8 as correct outcomes.
  func tailBindingChecks() throws -> Int {
    var count = 0
    func check(_ label: String, _ body: () throws -> Bool) throws {
      count += 1
      guard try body() else { fatalError("CHECK FAILED: \(label)") }
      print("PASS \(label)")
    }
    let wifi = URLSession(configuration: .background(withIdentifier: "harness.wifi"))
    let id = "tb"
    let url = "http://127.0.0.1:39321/f/tb"
    let owner = NSObject()
    var serial = 900
    queue.sync {
      listeners[ObjectIdentifier(owner)] = (progress: { _ in }, state: { _ in })
      sessions[true] = wifi
      sessions[false] = wifi
      reconciled = true
      appActive = false
    }
    /// Position-dependent bytes: one from the wrong offset is visible.
    func truth(_ range: Range<Int64>) -> Data { Data(range.map { UInt8($0 % 251) }) }
    func reset() {
      queue.sync {
        for key in Array(identityCycles.keys) { _ = dropCycle(key) }
        for ref in urlTasks.values { ref.task.cancel() }
        records.removeAll(); order.removeAll(); urlTasks.removeAll(); intents.removeAll(); awaitingResumeData.removeAll()
        cycleGenerations.removeAll(); probed.removeAll(); meters.removeAll(); baseline.removeAll(); assembling.removeAll(); pausePending.removeAll()
        folding.removeAll(); deleteResumeData(id); removeKeptFiles(id); clearTaskTracking(id)
        for path in ["blk", "tb.bin", "Show"] { try? FileManager.default.removeItem(at: try! resolve(path, nil)) }
        appActive = false
      }
    }
    defer {
      reset()
      queue.sync {
        listeners.removeValue(forKey: ObjectIdentifier(owner))
        sessions.removeAll()
      }
    }
    func waitUntil(_ condition: @escaping () -> Bool) {
      let until = Date().addingTimeInterval(10)
      while !queue.sync(execute: condition), Date() < until { Thread.sleep(forTimeInterval: 0.01) }
    }
    func temp(_ data: Data) -> URL {
      let url = supportURL.appendingPathComponent("tb-\(UUID().uuidString).tmp")
      try! data.write(to: url)
      return url
    }
    func fixture(_ status: Int, _ headers: [String: String], generation: Int, range: String? = nil) -> FixtureTask {
      serial += 1
      let task = FixtureTask(serial, status, headers, url: url)
      task.taskDescription = "\(id)#\(generation)"
      task.requestRange = range
      return task
    }
    func relaunch() {
      queue.sync {
        persist()
        records.removeAll(); order.removeAll(); urlTasks.removeAll(); clearTaskTracking(id)
        load()
        reconciled = true
      }
    }
    func record() -> DownloadRecord { queue.sync { records[id]! } }
    func snapLeft() -> Bool { queue.sync { FileManager.default.fileExists(atPath: snapFile(id).path) } }
    func keptData() -> Data { queue.sync { (try? Data(contentsOf: keptFile(id))) ?? Data() } }
    func published(_ path: String) -> Data { (try? Data(contentsOf: try resolve(path, nil))) ?? Data() }
    /// A fresh GET's task (generation of the record) that reports `bytes` and snapshots them as kept bytes.
    func freshGet(_ bytes: Int64, total: Int64, etag: String = "\"a\"") -> FixtureTask {
      queue.sync {
        let g = records[id]!.generation!
        urlTasks[id]?.task.cancel()
        let task = fixture(200, ["ETag": etag, "Content-Length": "\(total)", "Accept-Ranges": "bytes"], generation: g)
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: g, fromResumeData: false)
        baseline[id] = 0
        urlSession(wifi, downloadTask: task, didWriteData: bytes, totalBytesWritten: bytes, totalBytesExpectedToWrite: total)
        osFiles[id] = "CFNetworkDownload_tbfresh.tmp"
        try! truth(0..<bytes).write(to: osDownloadsURL.appendingPathComponent("CFNetworkDownload_tbfresh.tmp"))
        _ = snapshot(id)
        return task
      }
    }
    var atRequest: (record: DownloadRecord, snap: Bool)?
    /// Resumes and answers whatever Range the engine asks for with the server's bytes; returns that Range.
    func resumeToEnd(_ path: String, total: Int64, etag: String = "\"a\"", url renewed: String? = nil) throws -> String {
      try resume(id, url: renewed, headers: nil)
      waitUntil { !self.folding.contains(id) && self.urlTasks[id] != nil }
      atRequest = (record(), snapLeft())
      let range = queue.sync { urlTasks[id]?.task.currentRequest?.value(forHTTPHeaderField: "Range") ?? "none" }
      let start = Int64(range.dropFirst(6).dropLast()) ?? 0
      queue.sync {
        let g = records[id]!.generation!
        urlTasks[id]?.task.cancel()
        let task = start > 0
          ? fixture(206, ["ETag": etag, "Content-Range": "bytes \(start)-\(total - 1)/\(total)"], generation: g, range: range)
          : fixture(200, ["ETag": etag, "Content-Length": "\(total)"], generation: g)
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: g, fromResumeData: false)
        urlSession(wifi, downloadTask: task, didFinishDownloadingTo: temp(truth(start..<total)))
      }
      waitUntil { self.assembling[id] == nil }
      return range
    }
    /// An own Range continuation of `kept` bytes (generation g), validated, with a tail snapshot of `tail` bytes.
    func continuation(path: String, kept: Int64, tail: Int64, total: Int64) -> FixtureTask {
      queue.sync {
        let g = nextGeneration(after: 0)
        var record = DownloadRecord(id: id, url: url, headers: [:], relativePath: path, volumeId: "internal", expectedBytes: total,
          expectedEtag: nil, title: nil, state: DownloadStates.running, totalBytes: total, etag: "\"a\"", createdAt: 0, updatedAt: 0, generation: g)
        record.keptBytes = kept; record.keptEtag = "\"a\""; record.rangeOffset = kept; record.rangeGeneration = g; record.bytesWritten = kept
        try! truth(0..<kept).write(to: keptFile(id))
        records[id] = record
        order = [id]
        let task = fixture(206, ["ETag": "\"a\"", "Content-Range": "bytes \(kept)-\(total - 1)/\(total)"], generation: g, range: "bytes=\(kept)-")
        urlTasks[id] = TaskRef(task: task, session: "harness.wifi", generation: g, fromResumeData: false)
        baseline[id] = kept
        urlSession(wifi, downloadTask: task, didWriteData: tail, totalBytesWritten: tail, totalBytesExpectedToWrite: total - kept)
        osFiles[id] = "CFNetworkDownload_tbown.tmp"
        try! truth(kept..<(kept + tail)).write(to: osDownloadsURL.appendingPathComponent("CFNetworkDownload_tbown.tmp"))
        _ = snapshot(id)
        return task
      }
    }
    /// A paused record after an own continuation: `kept` bytes, a `.snap` of `snap` and the base it claims to extend.
    func pausedTail(kept: Int64, keptEtag: String = "\"a\"", keptFile extra: Data = Data(), snap: Data?, tail: Int64?, base: (Int) -> TailBase?,
      path: String = "tb.bin", total: Int64 = 4000) {
      queue.sync {
        let g = nextGeneration(after: 0)
        var record = DownloadRecord(id: id, url: url, headers: [:], relativePath: path, volumeId: "internal", expectedBytes: total,
          expectedEtag: nil, title: nil, state: DownloadStates.paused, totalBytes: total, etag: keptEtag, createdAt: 0, updatedAt: 0, generation: g)
        record.keptBytes = kept; record.keptEtag = keptEtag; record.rangeOffset = kept; record.rangeGeneration = g
        record.keptTailBytes = tail; record.tailBase = base(g); record.bytesWritten = kept + (tail ?? 0)
        try! (truth(0..<kept) + extra).write(to: keptFile(id))
        if let snap { try! snap.write(to: snapFile(id)) }
        records[id] = record
        order = [id]
      }
    }

    // N8-01: verifier round 8 check 1. A continuation whose publish failed, a fresh GET's new kept bytes, an in-task 410,
    // a renewal: the old tail never follows the new bytes.
    for relaunching in [false, true] {
      reset()
      let where_ = relaunching ? "across a relaunch" : "same process"
      let total: Int64 = 4000, kept: Int64 = 1000, tail: Int64 = 500, fresh: Int64 = 1500
      let own = continuation(path: "blk/tb.bin", kept: kept, tail: tail, total: total)
      let snapped = record().tailBase?.offset == kept && record().keptTailBytes == tail
      try Data("x".utf8).write(to: try resolve("blk", nil))
      queue.sync { urlSession(wifi, downloadTask: own, didFinishDownloadingTo: temp(truth(kept..<total))) }
      waitUntil { self.assembling[id] == nil }
      let failed = record()
      let failedSnap = snapLeft()
      if relaunching { relaunch() }
      try FileManager.default.removeItem(at: try resolve("blk", nil))
      try resume(id, url: nil, headers: nil)
      let freshTask = freshGet(fresh, total: total)
      let afterFresh = record()
      queue.sync {
        freshTask.http = HTTPURLResponse(url: URL(string: url)!, statusCode: 410, httpVersion: "HTTP/1.1", headerFields: [:])!
        urlSession(wifi, downloadTask: freshTask, didWriteData: 10, totalBytesWritten: fresh + 10, totalBytesExpectedToWrite: total)
        urlSession(wifi, task: freshTask, didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
      }
      let fellBack = record().bytesWritten
      let range = try resumeToEnd("blk/tb.bin", total: total, url: url + "?renewed")
      let done = record()
      let bytes = published("blk/tb.bin")
      print("N8-01 \(where_): failed publish \(failed.state) tail \(failed.keptTailBytes.map(String.init) ?? "nil") snap \(failedSnap); fresh kept "
        + "\(afterFresh.keptBytes.map(String.init) ?? "nil") tail \(afterFresh.keptTailBytes.map(String.init) ?? "nil"); fallback \(fellBack); next \(range); "
        + "\(done.state), published \(bytes.count) bytes, exact \(bytes == truth(0..<total))")
      try check("N8-01 \(where_): a failed publish ends its continuation's tail snapshot (fields and .snap)") {
        snapped && failed.state == DownloadStates.failed && failed.keptTailBytes == nil && failed.tailBase == nil && !failedSnap
      }
      try check("N8-01 \(where_): after a fresh GET's new kept bytes and a 410, the renewal continues them alone; published exactly the server's bytes") {
        afterFresh.keptBytes == fresh && fellBack == fresh && range == "bytes=\(fresh)-"
          && done.state == DownloadStates.completed && bytes == truth(0..<total)
      }
    }

    // N8-01 invariant: no published byte comes from a snapshot whose base differs from the kept length at fold time.
    let stale = Data(repeating: 0xEE, count: 500)
    let mismatches: [(String, Int64, String, Data, (Int) -> TailBase?)] = [
      ("whose base is another kept length", 1500, "\"a\"", stale, { TailBase(offset: 1000, etag: "\"a\"", generation: $0) }),
      ("whose base has another ETag", 1000, "\"b\"", stale, { TailBase(offset: 1000, etag: "\"a\"", generation: $0) }),
      ("whose base is another continuation", 1000, "\"a\"", stale, { TailBase(offset: 1000, etag: "\"a\"", generation: $0 - 1) }),
      ("without a base (written before 3g)", 1000, "\"a\"", stale, { _ in nil }),
    ]
    for (label, kept, etag, snap, base) in mismatches {
      reset()
      pausedTail(kept: kept, keptEtag: etag, snap: snap, tail: 500, base: base)
      let range = try resumeToEnd("tb.bin", total: 4000, etag: etag)
      try check("N8-01: a tail snapshot \(label) never folds and is gone by the request: Range bytes=\(kept)-, exact bytes") {
        range == "bytes=\(kept)-" && atRequest?.record.keptTailBytes == nil && atRequest?.record.tailBase == nil && atRequest?.snap == false
          && record().state == DownloadStates.completed && published("tb.bin") == truth(0..<4000)
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: truth(1000..<1500), tail: 500, base: { TailBase(offset: 1000, etag: "\"a\"", generation: $0) })
      let range = try resumeToEnd("tb.bin", total: 4000)
      try check("N8-01: a tail snapshot bound to these kept bytes folds and the Range follows it (control)") {
        range == "bytes=1500-" && record().state == DownloadStates.completed && published("tb.bin") == truth(0..<4000)
      }
    }

    // N8-01 defence in depth, each observable on its own.
    do {
      reset()
      pausedTail(kept: 1000, snap: truth(1000..<1500), tail: 500, base: { TailBase(offset: 1000, etag: "\"a\"", generation: $0) })
      queue.sync {
        var record = records[id]!
        record.state = DownloadStates.running
        record.generation = nextGeneration(after: record.generation!)
        records[id] = record
      }
      _ = freshGet(1600, total: 4000)
      let after = record()
      try check("N8-01: new kept bytes end any tail snapshot at once (fields and .snap)") {
        after.keptBytes == 1600 && after.keptTailBytes == nil && after.tailBase == nil && !snapLeft()
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: stale, tail: 500, base: { _ in nil })
      relaunch()
      let after = record()
      try check("N8-01: a tail snapshot without a binding goes at load (fields and .snap); the kept bytes stay") {
        after.keptBytes == 1000 && after.keptTailBytes == nil && after.tailBase == nil && !snapLeft() && after.bytesWritten == 1500
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: truth(1000..<1500), tail: nil, base: { _ in nil })
      relaunch()
      try check("N8-01: an orphan .snap (a crash between the fold's persist and its remove) goes at load") { !snapLeft() && record().keptBytes == 1000 }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: nil, tail: nil, base: { _ in nil })
      let source = temp(Data(repeating: 0x42, count: 100))
      let cloned = queue.sync { cloneKept(id, from: source, length: 1500, etag: "\"b\"") }
      let after = record()
      let onDisk = queue.sync { () -> DownloadRecord? in
        let stored = try? JSONDecoder().decode(StoredState.self, from: Data(contentsOf: stateURL))
        return stored?.tasks.first { $0.id == id }
      }
      try check("N8-02: kept bytes of another entity go (and are persisted) before new ones replace the file, even when the clone fails") {
        !cloned && after.keptBytes == nil && after.keptEtag == nil && onDisk?.keptBytes == nil && keptData().isEmpty
      }
    }

    // N8-02: verifier round 8 check 2. A crash during the fold, with 200 or all 500 tail bytes appended and not persisted.
    for appended in [Int64(200), Int64(500)] {
      reset()
      pausedTail(kept: 1000, keptFile: truth(1000..<(1000 + appended)), snap: truth(1000..<1500), tail: 500,
        base: { TailBase(offset: 1000, etag: "\"a\"", generation: $0) })
      relaunch()
      let after = record()
      let kept = keptData()
      let range = try resumeToEnd("tb.bin", total: 4000)
      try check("N8-02: a crash in the fold (\(appended) of 500 appended) keeps the 1,000 kept bytes and the bound tail; it folds again, Range bytes=1500-") {
        after.keptBytes == 1000 && kept == truth(0..<1000) && after.keptTailBytes == 500 && after.bytesWritten == 1500
          && range == "bytes=1500-" && record().state == DownloadStates.completed && published("tb.bin") == truth(0..<4000)
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, keptFile: truth(1000..<1200), snap: truth(1000..<1500), tail: 500, base: { _ in nil })
      relaunch()
      let after = record()
      let range = try resumeToEnd("tb.bin", total: 4000)
      try check("N8-02: the same crash with a 3f record (tail without binding): the 1,000 kept bytes stay, the tail goes, Range bytes=1000-") {
        after.keptBytes == 1000 && after.keptTailBytes == nil && after.bytesWritten == 1000 && range == "bytes=1000-" && published("tb.bin") == truth(0..<4000)
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, keptFile: truth(1000..<2700), snap: nil, tail: nil, base: { _ in nil })
      queue.sync { records[id]!.bytesWritten = 4000 }
      relaunch()
      let after = record()
      let range = try resumeToEnd("tb.bin", total: 4000)
      try check("N8-02: a crash during the Range assembly keeps the 1,000 kept bytes; the next Range is bytes=1000-") {
        after.keptBytes == 1000 && after.bytesWritten == 1000 && range == "bytes=1000-" && published("tb.bin") == truth(0..<4000)
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: nil, tail: nil, base: { _ in nil })
      try queue.sync { try truth(0..<800).write(to: keptFile(id)) }
      relaunch()
      try check("N8-02: a kept file shorter than its length still goes at load") { record().keptBytes == nil && keptData().isEmpty }
    }
    do {
      reset()
      let kept = temp(truth(0..<1000))
      let tail = temp(truth(1000..<4000))
      let appended = Self.appendOrCut(tail, to: kept, base: 1000, expectedSize: 4100)
      try check("N8-02: a failed continuation append cuts the kept file back to its first bytes") {
        !appended && (try? Data(contentsOf: kept)) == truth(0..<1000)
      }
    }
    do {
      reset()
      pausedTail(kept: 1000, snap: truth(1000..<1500), tail: 500, base: { TailBase(offset: 1000, etag: "\"a\"", generation: $0) })
      let g = queue.sync { () -> Int in
        var record = records[id]!
        record.state = DownloadStates.running
        records[id] = record
        assembling[id] = record.generation!
        return record.generation!
      }
      queue.sync { finishAssembly(id, generation: g, appended: false, pausing: false) }
      let after = record()
      let range = try resumeToEnd("tb.bin", total: 4000)
      try check("N8-02: a failed append is retried from the kept bytes (Range bytes=1000-), not from 0") {
        after.state == DownloadStates.retrying && after.keptBytes == 1000 && after.bytesWritten == 1000 && after.keptTailBytes == nil && !snapLeft()
          && range == "bytes=1000-" && published("tb.bin") == truth(0..<4000)
      }
    }

    // N8-03: a directory is never a download target; the publish never replaces one (verifier host case).
    func code(_ body: () throws -> Void) -> String? {
      do { try body(); return nil } catch let error as EngineError { return error.code } catch { return "\(error)" }
    }
    do {
      reset()
      let art = try resolve("Show/art", nil)
      try FileManager.default.createDirectory(at: art, withIntermediateDirectories: true)
      try Data("poster".utf8).write(to: art.appendingPathComponent("inside.txt"))
      let part = try resolve("Show/movie.bin.part", nil)
      try FileManager.default.createDirectory(at: part, withIntermediateDirectories: true)
      let atPath = code { _ = try start(["id": "dir1", "url": "http://127.0.0.1:9/dir1", "relativePath": "Show/art"]) }
      let atStaging = code { _ = try start(["id": "dir2", "url": "http://127.0.0.1:9/dir2", "relativePath": "Show/movie.bin"]) }
      let none = queue.sync { records["dir1"] == nil && records["dir2"] == nil }
      try check("N8-03: start refuses a path (or its .part) that is an existing directory with invalid_state, before any request") {
        atPath == "invalid_state" && atStaging == "invalid_state" && none && FileManager.default.fileExists(atPath: art.appendingPathComponent("inside.txt").path)
      }
      let source = temp(Data("media".utf8))
      let onto = code { try move(source, art) }
      let file = try resolve("Show/old.bin", nil)
      try Data("old".utf8).write(to: file)
      try move(temp(Data("new".utf8)), file)
      try check("N8-03: move never replaces a directory (its contents stay); it still replaces a file") {
        onto == "invalid_state" && FileManager.default.fileExists(atPath: art.appendingPathComponent("inside.txt").path)
          && FileManager.default.fileExists(atPath: source.path) && (try? Data(contentsOf: file)) == Data("new".utf8)
      }
    }
    do {
      reset()
      queue.sync {
        let g = nextGeneration(after: 0)
        records[id] = DownloadRecord(id: id, url: url, headers: [:], relativePath: "Show/art", volumeId: "internal", expectedBytes: 4000,
          expectedEtag: nil, title: nil, state: DownloadStates.queued, totalBytes: 4000, createdAt: 0, updatedAt: 0, generation: g)
        order = [id]
      }
      _ = freshGet(100, total: 4000)
      let art = try resolve("Show/art", nil)
      try FileManager.default.createDirectory(at: art, withIntermediateDirectories: true)
      try Data("poster".utf8).write(to: art.appendingPathComponent("inside.txt"))
      queue.sync { urlSession(wifi, downloadTask: urlTasks[id]!.task, didFinishDownloadingTo: temp(truth(0..<4000))) }
      let after = record()
      try check("N8-03: a directory created at the target while downloading fails the publish; the directory and its contents stay") {
        after.state == DownloadStates.failed && after.error?.message == "invalid_state: art is a directory" && Self.isDirectory(art)
          && FileManager.default.fileExists(atPath: art.appendingPathComponent("inside.txt").path)
      }
    }
    return count
  }
}
