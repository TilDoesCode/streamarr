#if os(iOS)
import Foundation
import Network

struct DownloadErrorInfo: Codable {
  var kind: String
  var message: String
  var httpStatus: Int?

  var map: [String: Any?] { ["kind": kind, "message": message, "httpStatus": httpStatus] }
}

struct DownloadRecord: Codable {
  let id: String
  var url: String
  var headers: [String: String]
  let relativePath: String
  let volumeId: String
  let expectedBytes: Int64?
  let expectedEtag: String?
  let title: String?
  var state: String
  var bytesWritten: Int64 = 0
  var totalBytes: Int64?
  var etag: String?
  var restarts = 0
  var attempts = 0
  var retryAt: Double?
  var error: DownloadErrorInfo?
  let createdAt: Double
  var updatedAt: Double

  var isActive: Bool { DownloadStates.active.contains(state) }
}

struct DownloadSettings: Codable {
  var wifiOnly = true
  var maxConcurrent = 2
}

private struct StoredState: Codable {
  var version = 1
  var settings: DownloadSettings
  var tasks: [DownloadRecord]
}

enum DownloadStates {
  static let queued = "queued"
  static let running = "running"
  static let paused = "paused"
  static let waitingNetwork = "waiting_network"
  static let waitingWifi = "waiting_wifi"
  static let retrying = "retrying"
  static let completed = "completed"
  static let failed = "failed"
  static let cancelled = "cancelled"
  static let active: Set<String> = [queued, running, waitingNetwork, waitingWifi, retrying]
}

struct EngineError: Error {
  let code: String
  let detail: String
  var message: String { "\(code): \(detail)" }
}

private enum StopIntent {
  case pause
  case requeue
  case cancel
  case fail(DownloadErrorInfo)
  case http(DownloadErrorInfo, retryable: Bool, retryAfter: Double?)
}

private struct Failure {
  let error: DownloadErrorInfo
  let retryable: Bool
  var retryAfter: Double?
}

/// Background URLSession download queue: one session for "Wi-Fi only" (no expensive/constrained networks) and one for any network.
final class OfflineDownloadEngine: NSObject, URLSessionDownloadDelegate {
  static let shared = OfflineDownloadEngine()

  var onProgress: (([String: Any?]) -> Void)?
  var onState: (([String: Any?]) -> Void)?

  let queue = DispatchQueue(label: "dev.streamarr.offline-downloads")
  let rootURL: URL
  private let supportURL: URL
  private let stateURL: URL
  private let resumeURL: URL
  private lazy var delegateQueue: OperationQueue = {
    let operations = OperationQueue()
    operations.maxConcurrentOperationCount = 1
    operations.underlyingQueue = queue
    return operations
  }()
  private var sessions: [Bool: URLSession] = [:]
  private var settings = DownloadSettings()
  private var records: [String: DownloadRecord] = [:]
  private var order: [String] = []
  private var urlTasks: [String: URLSessionDownloadTask] = [:]
  private var intents: [String: StopIntent] = [:]
  private var awaitingResumeData = Set<String>()
  private var finishedFiles = Set<String>()
  private var failures: [String: Failure] = [:]
  private var checkedResponse = Set<String>()
  private var baseline: [String: Int64] = [:]
  private var meters: [String: (at: Double, bytes: Int64, emitted: Double, speed: Double)] = [:]
  private var backgroundHandlers: [String: () -> Void] = [:]
  private var activated = false
  private var reconciled = false
  private let monitor = NWPathMonitor()
  private var path: NWPath?

  private static let maxAttempts = 8
  private static let progressResetsAttempts: Int64 = 1 << 20
  private static let reserveBytes: Int64 = 64 * 1024 * 1024

  private override init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    rootURL = support.appendingPathComponent("downloads", isDirectory: true)
    supportURL = support.appendingPathComponent("offline-downloads", isDirectory: true)
    stateURL = supportURL.appendingPathComponent("state.json")
    resumeURL = supportURL.appendingPathComponent("resume", isDirectory: true)
    super.init()
  }

  private var sessionPrefix: String { (Bundle.main.bundleIdentifier ?? "dev.streamarr.app") + ".offline-downloads" }

  // MARK: - Lifecycle

  func activate() {
    queue.sync {
      guard !activated else { return }
      activated = true
      for url in [rootURL, supportURL, resumeURL] {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        excludeFromBackup(url)
      }
      load()
      for wifiOnly in [true, false] {
        let configuration = URLSessionConfiguration.background(withIdentifier: "\(sessionPrefix).\(wifiOnly ? "wifi" : "any")")
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.allowsCellularAccess = !wifiOnly
        configuration.allowsExpensiveNetworkAccess = !wifiOnly
        configuration.allowsConstrainedNetworkAccess = !wifiOnly
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 14 * 24 * 3600
        sessions[wifiOnly] = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
      }
      monitor.pathUpdateHandler = { [weak self] path in
        guard let self else { return }
        self.path = path
        self.pump()
      }
      monitor.start(queue: queue)
      reconcile()
    }
  }

  /// Existing background tasks (the app was relaunched while nsurlsessiond kept downloading) are adopted by id.
  private func reconcile() {
    let group = DispatchGroup()
    var found: [URLSessionDownloadTask] = []
    for session in sessions.values {
      group.enter()
      session.getAllTasks { tasks in
        self.queue.async {
          found.append(contentsOf: tasks.compactMap { $0 as? URLSessionDownloadTask })
          group.leave()
        }
      }
    }
    group.notify(queue: queue) {
      for task in found {
        guard let id = task.taskDescription else { continue }
        if self.records[id]?.isActive == true, self.urlTasks[id] == nil {
          self.urlTasks[id] = task
          self.baseline[id] = self.records[id]?.bytesWritten ?? 0
          self.checkedResponse.insert(id)
        } else if self.urlTasks[id] !== task {
          task.cancel()
        }
      }
      self.reconciled = true
      self.pump()
    }
  }

  func handleEvents(identifier: String, completionHandler: @escaping () -> Void) {
    guard identifier.hasPrefix(sessionPrefix) else {
      completionHandler()
      return
    }
    activate()
    queue.async { self.backgroundHandlers[identifier] = completionHandler }
  }

  // MARK: - API (callers are off the engine queue)

  func start(_ spec: [String: Any]) throws -> [String: Any?] {
    try queue.sync {
      guard let id = spec["id"] as? String, !id.isEmpty else { throw EngineError(code: "invalid_argument", detail: "id is required") }
      if let existing = records[id] { return map(existing) }
      guard let url = spec["url"] as? String, url.hasPrefix("http://") || url.hasPrefix("https://"), URL(string: url) != nil else {
        throw EngineError(code: "invalid_argument", detail: "url must be http(s)")
      }
      guard let relativePath = spec["relativePath"] as? String else { throw EngineError(code: "invalid_argument", detail: "relativePath is required") }
      let volumeId = spec["volumeId"] as? String ?? "internal"
      _ = try resolve(relativePath, volumeId)
      let expected = (spec["expectedBytes"] as? NSNumber)?.int64Value
      let now = Date().timeIntervalSince1970 * 1000
      let record = DownloadRecord(
        id: id,
        url: url,
        headers: (spec["headers"] as? [String: Any])?.mapValues { "\($0)" } ?? [:],
        relativePath: relativePath,
        volumeId: volumeId,
        expectedBytes: expected,
        expectedEtag: spec["etag"] as? String,
        title: spec["notificationTitle"] as? String,
        state: DownloadStates.queued,
        totalBytes: expected,
        createdAt: now,
        updatedAt: now
      )
      records[id] = record
      order.append(id)
      emitState(record)
      persist()
      pump()
      return map(records[id] ?? record)
    }
  }

  func pause(_ id: String) throws {
    try queue.sync {
      guard var record = records[id] else { throw notFound(id) }
      guard record.isActive else { return }
      stop(id, .pause)
      record.retryAt = nil
      records[id] = record
      setState(id, DownloadStates.paused)
      persist()
      pump()
    }
  }

  func resume(_ id: String, url: String?, headers: [String: String]?) throws {
    try queue.sync {
      guard var record = records[id] else { throw notFound(id) }
      if let url {
        guard url.hasPrefix("http://") || url.hasPrefix("https://") else { throw EngineError(code: "invalid_argument", detail: "url must be http(s)") }
        record.url = url
      }
      if let headers { record.headers = headers }
      let changedRequest = url != nil || headers != nil
      if record.state == DownloadStates.paused || record.state == DownloadStates.failed || record.state == DownloadStates.retrying {
        if record.state != DownloadStates.retrying {
          record.attempts = 0
          record.error = nil
        }
        record.retryAt = nil
        records[id] = record
        // Resume data carries the old request; a new URL or headers start a fresh request.
        if changedRequest { deleteResumeData(id) }
        setState(id, DownloadStates.queued)
      } else {
        records[id] = record
        if changedRequest, urlTasks[id] != nil {
          deleteResumeData(id)
          intents[id] = .requeue
          urlTasks[id]?.cancel()
        }
      }
      persist()
      pump()
    }
  }

  func cancel(_ id: String) throws {
    try queue.sync {
      guard var record = records.removeValue(forKey: id) else { throw notFound(id) }
      order.removeAll { $0 == id }
      if let task = urlTasks[id] {
        intents[id] = .cancel
        task.cancel()
      }
      deleteResumeData(id)
      record.error = DownloadErrorInfo(kind: "cancelled", message: "cancelled")
      emitState(record, state: DownloadStates.cancelled)
      persist()
      pump()
    }
  }

  func remove(_ id: String) throws {
    try queue.sync {
      guard let record = records[id] else { throw notFound(id) }
      if record.isActive || record.state == DownloadStates.paused {
        throw EngineError(code: "invalid_state", detail: "download \(id) is \(record.state)")
      }
      records.removeValue(forKey: id)
      order.removeAll { $0 == id }
      deleteResumeData(id)
      persist()
    }
  }

  func list() -> [[String: Any?]] { queue.sync { order.compactMap { records[$0] }.map(map) } }

  func get(_ id: String) -> [String: Any?]? { queue.sync { records[id].map(map) } }

  func currentSettings() -> DownloadSettings { queue.sync { settings } }

  func setWifiOnly(_ wifiOnly: Bool) {
    queue.sync {
      guard settings.wifiOnly != wifiOnly else { return }
      settings.wifiOnly = wifiOnly
      persist()
      // Tasks keep the policy of the session they run in: move them over with their resume data.
      for id in Array(urlTasks.keys) { stop(id, .requeue) }
      pump()
    }
  }

  func setMaxConcurrent(_ value: Int) {
    queue.sync {
      settings.maxConcurrent = min(6, max(1, value))
      persist()
      pump()
    }
  }

  // MARK: - Files

  func resolve(_ relativePath: String, _ volumeId: String?) throws -> URL {
    if let volumeId, volumeId != "internal" { throw EngineError(code: "not_found", detail: "unknown volume \(volumeId)") }
    guard !relativePath.isEmpty else { throw EngineError(code: "invalid_argument", detail: "empty path") }
    let root = rootURL.standardizedFileURL.path
    let url = rootURL.appendingPathComponent(relativePath).standardizedFileURL
    guard url.path.hasPrefix(root + "/") else { throw EngineError(code: "invalid_argument", detail: "path escapes the download root: \(relativePath)") }
    return url
  }

  func storage() throws -> [String: Any] {
    try? FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    let values = try rootURL.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
    return [
      "freeBytes": Double(values.volumeAvailableCapacityForImportantUsage ?? 0),
      "totalBytes": Double(values.volumeTotalCapacity ?? 0),
    ]
  }

  func freeBytes() -> Int64 {
    Int64((try? rootURL.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage ?? 0)
  }

  func move(_ from: URL, _ to: URL) throws {
    let files = FileManager.default
    guard files.fileExists(atPath: from.path) else { throw EngineError(code: "not_found", detail: "missing \(from.lastPathComponent)") }
    try files.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    if files.fileExists(atPath: to.path) {
      _ = try files.replaceItemAt(to, withItemAt: from)
    } else {
      try files.moveItem(at: from, to: to)
    }
    excludeFromBackup(to)
  }

  func excludeFromBackup(_ url: URL) {
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? target.setResourceValues(values)
  }

  func isExcludedFromBackup(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup ?? false
  }

  // MARK: - Queue

  private func blockedState() -> String? {
    guard let path else { return nil }
    if path.status != .satisfied { return DownloadStates.waitingNetwork }
    if settings.wifiOnly && (path.isExpensive || path.isConstrained) { return DownloadStates.waitingWifi }
    return nil
  }

  /// Background tasks wait for a matching network on their own, so running tasks only change their reported state.
  private func pump() {
    guard reconciled else { return }
    let active = order.compactMap { records[$0] }.filter(\.isActive)
    let blocked = blockedState()
    let live = urlTasks.keys.filter { intents[$0] == nil }
    if live.count > settings.maxConcurrent {
      for id in live.sorted(by: { (records[$0]?.createdAt ?? 0) > (records[$1]?.createdAt ?? 0) }).prefix(live.count - settings.maxConcurrent) {
        stop(id, .requeue)
      }
    }
    var slots = settings.maxConcurrent - urlTasks.count
    let now = Date().timeIntervalSince1970 * 1000
    for record in active {
      let id = record.id
      if urlTasks[id] != nil {
        if intents[id] == nil { setState(id, blocked ?? DownloadStates.running) }
        continue
      }
      if awaitingResumeData.contains(id) { continue }
      if record.state == DownloadStates.retrying, let retryAt = record.retryAt, retryAt > now {
        queue.asyncAfter(deadline: .now() + (retryAt - now) / 1000) { [weak self] in self?.pump() }
        continue
      }
      if slots > 0 {
        begin(id, blocked: blocked)
        slots -= 1
      } else {
        setState(id, DownloadStates.queued)
      }
    }
    persist()
  }

  private func begin(_ id: String, blocked: String?) {
    guard var record = records[id], let session = sessions[settings.wifiOnly], let url = URL(string: record.url) else { return }
    if let total = record.totalBytes, freeBytes() < total - record.bytesWritten + Self.reserveBytes {
      fail(id, DownloadErrorInfo(kind: "disk_full", message: "needs \(total - record.bytesWritten) bytes, \(freeBytes()) free"))
      return
    }
    let task: URLSessionDownloadTask
    if let data = loadResumeData(id) {
      task = session.downloadTask(withResumeData: data)
      deleteResumeData(id)
    } else {
      var request = URLRequest(url: url)
      request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      record.headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
      task = session.downloadTask(with: request)
      record.bytesWritten = 0
    }
    task.taskDescription = id
    if let total = record.totalBytes { task.countOfBytesClientExpectsToReceive = max(0, total - record.bytesWritten) }
    record.retryAt = nil
    records[id] = record
    urlTasks[id] = task
    baseline[id] = record.bytesWritten
    checkedResponse.remove(id)
    setState(id, blocked ?? DownloadStates.running)
    task.resume()
  }

  private func stop(_ id: String, _ intent: StopIntent) {
    guard let task = urlTasks[id] else { return }
    intents[id] = intent
    switch intent {
    case .pause, .requeue:
      awaitingResumeData.insert(id)
      task.cancel(byProducingResumeData: { [weak self] data in
        guard let self else { return }
        self.queue.async {
          if let data { self.saveResumeData(id, data) }
          self.awaitingResumeData.remove(id)
          self.pump()
        }
      })
    default:
      task.cancel()
    }
  }

  private func handle(_ id: String, _ failure: Failure) {
    guard var record = records[id], record.isActive else { return }
    if record.bytesWritten - (baseline[id] ?? 0) >= Self.progressResetsAttempts { record.attempts = 0 }
    record.error = failure.error
    if failure.retryable, path?.status == .unsatisfied {
      records[id] = record
      setState(id, DownloadStates.waitingNetwork)
      return
    }
    record.attempts += 1
    if failure.retryable, record.attempts < Self.maxAttempts {
      let delay = failure.retryAfter ?? min(60, 2 * pow(2, Double(record.attempts - 1)))
      record.retryAt = Date().timeIntervalSince1970 * 1000 + delay * 1000
      records[id] = record
      NSLog("[OfflineDownloads] %@: %@, retry %d in %.0fs", id, failure.error.message, record.attempts, delay)
      setState(id, DownloadStates.retrying)
    } else {
      records[id] = record
      fail(id, failure.error)
    }
  }

  private func fail(_ id: String, _ error: DownloadErrorInfo) {
    guard var record = records[id] else { return }
    record.error = error
    record.retryAt = nil
    records[id] = record
    NSLog("[OfflineDownloads] %@ failed: %@ %@", id, error.kind, error.message)
    setState(id, DownloadStates.failed)
  }

  // MARK: - URLSessionDownloadDelegate (engine queue)

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let id = downloadTask.taskDescription, var record = records[id], urlTasks[id] === downloadTask else { return }
    if !checkedResponse.contains(id) {
      checkedResponse.insert(id)
      if let failure = checkResponse(downloadTask, record: &record, expectedTotal: totalBytesExpectedToWrite) {
        records[id] = record
        intents[id] = failure.retryable ? .http(failure.error, retryable: true, retryAfter: failure.retryAfter) : .fail(failure.error)
        downloadTask.cancel()
        return
      }
      record.error = nil
      if totalBytesWritten < (baseline[id] ?? 0) / 2 {
        record.restarts += 1
        baseline[id] = 0
        NSLog("[OfflineDownloads] %@: validator changed, starting over", id)
      }
    }
    record.bytesWritten = totalBytesWritten
    if totalBytesExpectedToWrite > 0 { record.totalBytes = totalBytesExpectedToWrite }
    records[id] = record
    if intents[id] == nil, blockedState() == nil { setState(id, DownloadStates.running) }
    let now = Date().timeIntervalSince1970
    var meter = meters[id] ?? (at: now, bytes: totalBytesWritten, emitted: 0, speed: 0)
    if now - meter.at >= 0.5 {
      let instant = Double(max(0, totalBytesWritten - meter.bytes)) / (now - meter.at)
      meter.speed = meter.speed == 0 ? instant : meter.speed * 0.7 + instant * 0.3
      meter.at = now
      meter.bytes = totalBytesWritten
    }
    if now - meter.emitted >= 0.5 {
      meter.emitted = now
      onProgress?(["id": id, "bytesWritten": Double(totalBytesWritten), "totalBytes": record.totalBytes.map(Double.init), "bytesPerSecond": meter.speed])
    }
    meters[id] = meter
  }

  private func checkResponse(_ task: URLSessionDownloadTask, record: inout DownloadRecord, expectedTotal: Int64) -> Failure? {
    guard let http = task.response as? HTTPURLResponse else { return nil }
    if let failure = statusFailure(http) { return failure }
    let etag = http.value(forHTTPHeaderField: "ETag")
    if let expected = record.expectedEtag, let etag, etag != expected {
      return Failure(error: DownloadErrorInfo(kind: "validator_changed", message: "ETag \(etag), expected \(expected)"), retryable: false)
    }
    if let expected = record.expectedBytes, expectedTotal > 0, expectedTotal != expected {
      return Failure(error: DownloadErrorInfo(kind: "size_mismatch", message: "server size \(expectedTotal), expected \(expected)"), retryable: false)
    }
    record.etag = etag ?? record.etag
    return nil
  }

  private func statusFailure(_ http: HTTPURLResponse) -> Failure? {
    let status = http.statusCode
    guard !(200..<300).contains(status) else { return nil }
    let retryable = [408, 425, 429, 500, 502, 503, 504].contains(status)
    let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
    return Failure(error: DownloadErrorInfo(kind: "http", message: "HTTP \(status)", httpStatus: status), retryable: retryable, retryAfter: retryAfter)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let id = downloadTask.taskDescription, let record = records[id] else { return }
    if let http = downloadTask.response as? HTTPURLResponse, let failure = statusFailure(http) {
      failures[id] = failure
      return
    }
    let size = ((try? FileManager.default.attributesOfItem(atPath: location.path)[.size]) as? NSNumber)?.int64Value ?? 0
    if let expected = record.expectedBytes, size != expected {
      failures[id] = Failure(error: DownloadErrorInfo(kind: "size_mismatch", message: "received \(size) of \(expected)"), retryable: false)
      return
    }
    do {
      try move(location, try resolve(record.relativePath, record.volumeId))
      finishedFiles.insert(id)
      records[id]?.bytesWritten = size
      records[id]?.totalBytes = size
    } catch {
      let full = (error as NSError).code == NSFileWriteOutOfSpaceError
      failures[id] = Failure(error: DownloadErrorInfo(kind: full ? "disk_full" : "file_system", message: error.localizedDescription), retryable: false)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }
    if urlTasks[id] === task { urlTasks.removeValue(forKey: id) }
    let intent = intents.removeValue(forKey: id)
    meters.removeValue(forKey: id)
    let nsError = error as NSError?
    if let data = nsError?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data, records[id] != nil { saveResumeData(id, data) }
    defer {
      persist()
      pump()
    }
    guard records[id] != nil else { return }
    if finishedFiles.remove(id) != nil {
      records[id]?.attempts = 0
      records[id]?.error = nil
      setState(id, DownloadStates.completed)
      if let record = records[id] {
        onProgress?(["id": id, "bytesWritten": Double(record.bytesWritten), "totalBytes": record.totalBytes.map(Double.init), "bytesPerSecond": 0.0])
      }
      return
    }
    if let failure = failures.removeValue(forKey: id) {
      deleteResumeData(id)
      handle(id, failure)
      return
    }
    switch intent {
    case .pause, .cancel:
      return
    case .requeue:
      if records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    case .fail(let info):
      deleteResumeData(id)
      fail(id, info)
      return
    case .http(let info, let retryable, let retryAfter):
      deleteResumeData(id)
      handle(id, Failure(error: info, retryable: retryable, retryAfter: retryAfter))
      return
    case nil:
      break
    }
    guard let nsError else {
      handle(id, Failure(error: DownloadErrorInfo(kind: "unknown", message: "finished without a file"), retryable: true))
      return
    }
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
      // The user swiped the app away (or iOS stopped the session): continue from the resume data.
      if records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    }
    let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
    if nsError.code == NSURLErrorCannotWriteToFile || underlying?.code == Int(ENOSPC) {
      fail(id, DownloadErrorInfo(kind: "disk_full", message: nsError.localizedDescription))
      return
    }
    if nsError.domain == NSURLErrorDomain, [NSURLErrorBadURL, NSURLErrorUnsupportedURL].contains(nsError.code) {
      fail(id, DownloadErrorInfo(kind: "network", message: nsError.localizedDescription))
      return
    }
    handle(id, Failure(error: DownloadErrorInfo(kind: "network", message: "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)"), retryable: true))
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier, let handler = backgroundHandlers.removeValue(forKey: identifier) else { return }
    DispatchQueue.main.async(execute: handler)
  }

  // MARK: - State

  private func setState(_ id: String, _ state: String) {
    guard var record = records[id], record.state != state else { return }
    record.state = state
    record.updatedAt = Date().timeIntervalSince1970 * 1000
    records[id] = record
    emitState(record)
  }

  private func emitState(_ record: DownloadRecord, state: String? = nil) {
    var payload = map(record)
    let current = state ?? record.state
    payload["state"] = current
    onState?(["id": record.id, "state": current, "task": payload])
  }

  func map(_ record: DownloadRecord) -> [String: Any?] {
    [
      "id": record.id,
      "url": record.url,
      "relativePath": record.relativePath,
      "volumeId": record.volumeId,
      "uri": (try? resolve(record.relativePath, record.volumeId).absoluteString) ?? "",
      "state": record.state,
      "bytesWritten": Double(record.bytesWritten),
      "totalBytes": record.totalBytes.map(Double.init),
      "etag": record.etag,
      "restarts": record.restarts,
      "attempts": record.attempts,
      "retryAt": record.retryAt,
      "error": record.error?.map,
      "createdAt": record.createdAt,
      "updatedAt": record.updatedAt,
    ]
  }

  private func notFound(_ id: String) -> EngineError { EngineError(code: "not_found", detail: "no download \(id)") }

  private func load() {
    guard let data = try? Data(contentsOf: stateURL), let stored = try? JSONDecoder().decode(StoredState.self, from: data) else { return }
    settings = stored.settings
    for record in stored.tasks {
      records[record.id] = record
      order.append(record.id)
    }
  }

  private func persist() {
    let state = StoredState(settings: settings, tasks: order.compactMap { records[$0] })
    guard let data = try? JSONEncoder().encode(state) else { return }
    try? data.write(to: stateURL, options: .atomic)
  }

  private func resumeFile(_ id: String) -> URL {
    let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id
    return resumeURL.appendingPathComponent("\(safe).resume")
  }

  private func saveResumeData(_ id: String, _ data: Data) { try? data.write(to: resumeFile(id), options: .atomic) }

  private func loadResumeData(_ id: String) -> Data? { try? Data(contentsOf: resumeFile(id)) }

  private func deleteResumeData(_ id: String) { try? FileManager.default.removeItem(at: resumeFile(id)) }
}
#endif
