import Foundation

// Verifier Swift repros (DL-N-verify1/2) turned around: each check asserts the correct outcome of the actual engine.
private final class FixtureTask: URLSessionDownloadTask, @unchecked Sendable {
  var delayResumeData = false
  var resumeCompletion: (@Sendable (Data?) -> Void)?
  let serial: Int
  let http: HTTPURLResponse
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
  override func cancel() {}
  override func cancel(byProducingResumeData completionHandler: @escaping @Sendable (Data?) -> Void) {
    if delayResumeData { resumeCompletion = completionHandler } else { completionHandler(nil) }
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
    for url in [supportURL, resumeURL, stagedURL, keptURL, osDownloadsURL] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
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
      for name in (try? FileManager.default.contentsOfDirectory(atPath: osDownloadsURL.path)) ?? [] {
        try? FileManager.default.removeItem(at: osDownloadsURL.appendingPathComponent(name))
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
      ["", ".tail", ".new"].allSatisfy { !FileManager.default.fileExists(atPath: keptFile(id).path + $0) }
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

@main enum EngineHostCheck {
  static func main() throws {
    setvbuf(stdout, nil, _IOLBF, 0)
    let engine = OfflineDownloadEngine.shared
    let count = try engine.queue.sync { try engine.hostChecks() } + engine.tombstoneChecks() + engine.continuationChecks()
    print("Swift engine host: \(count)/\(count) checks passed")
  }
}
