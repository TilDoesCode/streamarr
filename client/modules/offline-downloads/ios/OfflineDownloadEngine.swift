#if os(iOS)
import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

struct DownloadErrorInfo: Codable {
  var kind: String
  var message: String
  var httpStatus: Int?
  var retryAfterMs: Double?

  /// Absent fields are left out (the JS type has them optional, not nullable).
  var map: [String: Any] {
    var values: [String: Any] = ["kind": kind, "message": message]
    if let httpStatus { values["httpStatus"] = httpStatus }
    if let retryAfterMs { values["retryAfterMs"] = retryAfterMs }
    return values
  }
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
  /// Strong ETag of the bytes so far.
  var etag: String?
  var restarts = 0
  var attempts = 0
  /// Wall-clock display of the next attempt; the engine waits for `retryDue`.
  var retryAt: Double?
  /// Next attempt on the continuous clock (keeps running in sleep, N2-04).
  var retryDue: Double?
  /// The whole wait `retryDue` belongs to (bounds its restore after a reboot).
  var retryDelay: Double?
  var error: DownloadErrorInfo?
  let createdAt: Double
  var updatedAt: Double
  /// Bumped for every URLSession task; only callbacks of the current generation count (N1-05).
  var generation: Int?
  /// Generation whose response passed validation (persisted, so adopted tasks are validated again otherwise).
  var validatedGeneration: Int?
  /// Start of server-directed waiting (Retry-After answers) without byte progress, on the continuous clock.
  var waitingSince: Double?
  /// Where the OS resumed `resumeOffsetGeneration` (didResumeAtOffset): a 206 must start exactly there (N2-07).
  var resumeOffset: Int64?
  var resumeOffsetGeneration: Int?
  /// The file finished while a pause was pending: it waits in `staged/` until resume.
  var staged: Bool?

  var isActive: Bool { DownloadStates.active.contains(state) }

  mutating func clearRetry() {
    retryAt = nil
    retryDue = nil
    retryDelay = nil
  }
}

struct DownloadSettings: Codable {
  var wifiOnly = true
  var maxConcurrent = 2
}

/// Continuous clock, boot identity and wall clock at the save: waits are restored against them (N2-04).
private struct SavedClock: Codable {
  var bootId: String?
  var elapsed: Double
  var wall: Double
}

/// 2: wall-clock waits; 3: continuous-clock waits plus the clock at the save and the generation counter.
private struct StoredState: Codable {
  var version = 3
  var settings: DownloadSettings
  var tasks: [DownloadRecord]
  var clock: SavedClock?
  var generationClock: Int?
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

private struct Failure {
  let error: DownloadErrorInfo
  let retryable: Bool
  var retryAfterMs: Double?
  /// The bytes so far are discarded (resume data deleted, the next attempt starts at 0).
  var dropPartial = false
}

private enum StopIntent {
  case pause
  /// Same request, another session or slot: a finished file is still this record's file.
  case requeue
  /// A new URL or header set replaced the request (N2-08).
  case replace
  case cancel
  case failure(Failure)
}

private struct TaskRef {
  let task: URLSessionDownloadTask
  let session: String
  let generation: Int
  let fromResumeData: Bool

  func matches(_ session: URLSession, _ task: URLSessionTask, _ generation: Int) -> Bool {
    self.session == session.configuration.identifier && self.task.taskIdentifier == task.taskIdentifier && self.generation == generation
  }
}

/// Keeps the app running briefly while a probe hands work over to the background session; ends exactly once.
private final class BackgroundAssertion: @unchecked Sendable {
  private let lock = NSLock()
  private var token: Int?

  init(_ name: String, expired: @escaping () -> Void) {
    #if canImport(UIKit)
      let raw = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
        expired()
        self?.end()
      }.rawValue
      lock.lock()
      token = raw
      lock.unlock()
    #endif
  }

  func end() {
    lock.lock()
    let raw = token
    token = nil
    lock.unlock()
    #if canImport(UIKit)
      if let raw, raw != UIBackgroundTaskIdentifier.invalid.rawValue {
        UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: raw))
      }
    #endif
  }
}

/// Background URLSession download queue: one session for "Wi-Fi only" (no expensive/constrained networks) and one for any network.
final class OfflineDownloadEngine: NSObject, URLSessionDownloadDelegate {
  static let shared = OfflineDownloadEngine()

  typealias Listener = (progress: ([String: Any?]) -> Void, state: ([String: Any?]) -> Void)

  let queue = DispatchQueue(label: "dev.streamarr.offline-downloads")
  let rootURL: URL
  private let supportURL: URL
  private let stateURL: URL
  private let resumeURL: URL
  private let stagedURL: URL
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
  private var urlTasks: [String: TaskRef] = [:]
  private var intents: [String: StopIntent] = [:]
  /// Generation whose resume data is on the way; a completion of another generation is stale (N2-03).
  private var awaitingResumeData: [String: Int] = [:]
  /// Every generation ever handed out is below it: a reused id never matches a predecessor's task (N2-03).
  private var generationClock = 0
  /// `session#taskIdentifier` of tasks whose outcome didFinishDownloadingTo applied; completion only cleans up.
  private var finishedTasks = Set<String>()
  /// Tasks whose completion arrived before reconcile finished; reconcile must not adopt them again.
  private var settledEarly = Set<String>()
  /// The probe each id waits for; a completion with another token is stale (N2-03).
  private var probing: [String: UUID] = [:]
  private var probed = Set<String>()
  private var assertions: [String: BackgroundAssertion] = [:]
  private lazy var probeSessions: [Bool: URLSession] = Dictionary(uniqueKeysWithValues: [true, false].map { wifiOnly in
    let configuration = URLSessionConfiguration.ephemeral
    configuration.allowsCellularAccess = !wifiOnly
    configuration.allowsExpensiveNetworkAccess = !wifiOnly
    configuration.allowsConstrainedNetworkAccess = !wifiOnly
    configuration.timeoutIntervalForRequest = 20
    return (wifiOnly, URLSession(configuration: configuration))
  })
  private var baseline: [String: Int64] = [:]
  private var lastSpaceCheck: [String: Int64] = [:]
  private var meters: [String: (at: Double, bytes: Int64, emitted: Double, speed: Double)] = [:]
  private var backgroundHandlers: [String: () -> Void] = [:]
  /// One entry per module instance: a reloaded JS runtime adds its own before the old one is destroyed.
  private var listeners: [ObjectIdentifier: Listener] = [:]
  private var retryTimer: DispatchWorkItem?
  private var activated = false
  private var reconciled = false
  private let monitor = NWPathMonitor()
  private var path: NWPath?

  private static let spaceCheckBytes: Int64 = 64 * 1024 * 1024

  private override init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    rootURL = support.appendingPathComponent("downloads", isDirectory: true)
    supportURL = support.appendingPathComponent("offline-downloads", isDirectory: true)
    stateURL = supportURL.appendingPathComponent("state.json")
    resumeURL = supportURL.appendingPathComponent("resume", isDirectory: true)
    stagedURL = supportURL.appendingPathComponent("staged", isDirectory: true)
    super.init()
  }

  private var sessionPrefix: String { (Bundle.main.bundleIdentifier ?? "dev.streamarr.app") + ".offline-downloads" }

  private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

  private static let timebase: (numer: Double, denom: Double) = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return (Double(info.numer), Double(info.denom))
  }()

  /// Continuous clock in ms since boot (keeps running in sleep): every wait and budget runs on it (N2-04).
  private var elapsedMs: Double { Double(mach_continuous_time()) * Self.timebase.numer / Self.timebase.denom / 1_000_000 }

  /// The boot session; `kern.boottime` (moves with wall-clock changes, so such a change counts like a reboot) as fallback.
  private static let bootId: String? = {
    var size = 0
    if sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 {
      var buffer = [CChar](repeating: 0, count: size)
      if sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 { return String(cString: buffer) }
    }
    var boot = timeval()
    size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &boot, &size, nil, 0) == 0 else { return nil }
    return "boottime-\(boot.tv_sec).\(boot.tv_usec)"
  }()

  // MARK: - Lifecycle

  func activate() {
    queue.sync {
      guard !activated else { return }
      activated = true
      for url in [rootURL, supportURL, resumeURL, stagedURL] {
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

  /// `id#generation` (tasks from builds before generations carry only the id: generation 0).
  private static func describe(_ description: String?) -> (id: String, generation: Int)? {
    guard let description, !description.isEmpty else { return nil }
    guard let hash = description.lastIndex(of: "#"), let generation = Int(description[description.index(after: hash)...]) else {
      return (description, 0)
    }
    return (String(description[..<hash]), generation)
  }

  private static func taskKey(_ session: URLSession, _ task: URLSessionTask) -> String {
    "\(session.configuration.identifier ?? "?")#\(task.taskIdentifier)"
  }

  /// The task's id when it is the current task of the current generation in its session (N1-05).
  private func current(_ session: URLSession, _ task: URLSessionTask) -> (id: String, ref: TaskRef)? {
    guard let (id, generation) = Self.describe(task.taskDescription), (records[id]?.generation ?? 0) == generation else { return nil }
    if urlTasks[id] == nil, intents[id] == nil, records[id]?.isActive == true, let download = task as? URLSessionDownloadTask {
      NSLog("[OfflineDownloads] %@: adopting task %d from a relaunch", id, task.taskIdentifier)
      adopt(id, download, session)
    }
    guard let ref = urlTasks[id], ref.matches(session, task, generation) else { return nil }
    return (id, ref)
  }

  private func adopt(_ id: String, _ task: URLSessionDownloadTask, _ session: URLSession) {
    guard let record = records[id], let (_, generation) = Self.describe(task.taskDescription), let identifier = session.configuration.identifier else { return }
    urlTasks[id] = TaskRef(task: task, session: identifier, generation: generation, fromResumeData: false)
    baseline[id] = record.bytesWritten
    lastSpaceCheck[id] = record.bytesWritten
  }

  /// Current-generation tasks (also finished ones whose events are pending) are adopted and validated again (N1-06).
  private func reconcile() {
    let group = DispatchGroup()
    var found: [(URLSessionTask, URLSession)] = []
    for session in sessions.values {
      group.enter()
      session.getAllTasks { tasks in
        self.queue.async {
          found.append(contentsOf: tasks.map { ($0, session) })
          group.leave()
        }
      }
    }
    group.notify(queue: queue) {
      for (task, session) in found where !self.settledEarly.contains(Self.taskKey(session, task)) {
        guard let download = task as? URLSessionDownloadTask, let (id, generation) = Self.describe(task.taskDescription),
          let record = self.records[id], record.isActive, (record.generation ?? 0) == generation, self.urlTasks[id] == nil else {
          if task.state != .completed { task.cancel() }
          continue
        }
        if task.state == .suspended { task.resume() }
        self.adopt(id, download, session)
        if task.state == .completed { self.awaitEvents(id, download) }
      }
      self.settledEarly.removeAll()
      self.reconciled = true
      self.pump()
    }
  }

  /// A finished task's events normally follow at once; if they never come, the download starts again.
  private func awaitEvents(_ id: String, _ task: URLSessionDownloadTask) {
    queue.asyncAfter(deadline: .now() + 30) {
      guard self.urlTasks[id]?.task === task else { return }
      NSLog("[OfflineDownloads] %@: no events for finished task %d", id, task.taskIdentifier)
      self.urlTasks.removeValue(forKey: id)
      self.pump()
    }
  }

  func addListener(_ owner: AnyObject, _ listener: Listener) {
    let key = ObjectIdentifier(owner)
    queue.async { self.listeners[key] = listener }
  }

  func removeListener(_ owner: AnyObject) {
    let key = ObjectIdentifier(owner)
    queue.async { self.listeners.removeValue(forKey: key) }
  }

  private func emitProgress(_ event: [String: Any?]) {
    listeners.values.forEach { $0.progress(event) }
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
      ensureRoot()
      if let existing = records[id] { return map(existing) }
      guard let url = spec["url"] as? String, url.hasPrefix("http://") || url.hasPrefix("https://"), URL(string: url) != nil else {
        throw EngineError(code: "invalid_argument", detail: "url must be http(s)")
      }
      guard let relativePath = spec["relativePath"] as? String else { throw EngineError(code: "invalid_argument", detail: "relativePath is required") }
      let headers = (spec["headers"] as? [String: Any])?.mapValues { "\($0)" } ?? [:]
      try checkHeaders(headers)
      let volumeId = spec["volumeId"] as? String ?? "internal"
      _ = try resolve(relativePath, volumeId)
      let key = try Self.claimKey(volumeId, relativePath)
      guard !key.hasSuffix(Self.stagingSuffix) else {
        throw EngineError(code: "invalid_argument", detail: "a download path may not end in \(Self.stagingSuffix): \(relativePath)")
      }
      // A cancelled tombstone owns nothing (fix round 1c); final and staging paths conflict with ancestors too (N2-01).
      if let owner = order.first(where: { other in
        guard let record = records[other], record.state != DownloadStates.cancelled else { return false }
        return Self.conflicts(record, Self.claims(key))
      }) {
        throw EngineError(code: "invalid_state", detail: "path \(relativePath) belongs to download \(owner)")
      }
      forget(id)
      let expected = (spec["expectedBytes"] as? NSNumber)?.int64Value
      let now = nowMs
      let record = DownloadRecord(
        id: id,
        url: url,
        headers: headers,
        relativePath: relativePath,
        volumeId: volumeId,
        expectedBytes: expected,
        expectedEtag: spec["etag"] as? String,
        title: spec["notificationTitle"] as? String,
        state: DownloadStates.queued,
        totalBytes: expected,
        createdAt: now,
        updatedAt: now,
        generation: nextGeneration(after: 0)
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
      record.clearRetry()
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
      if let headers {
        try checkHeaders(headers)
        record.headers = headers
      }
      let changedRequest = url != nil || headers != nil
      if record.state == DownloadStates.paused || record.state == DownloadStates.failed || record.state == DownloadStates.retrying {
        if record.state != DownloadStates.retrying {
          record.attempts = 0
          record.waitingSince = nil
          record.error = nil
        }
        record.clearRetry()
        records[id] = record
        // Resume data carries the old request; a new URL or headers start a fresh request.
        if changedRequest { deleteResumeData(id) }
        setState(id, DownloadStates.queued)
      } else {
        records[id] = record
        if changedRequest, urlTasks[id] != nil {
          deleteResumeData(id)
          stop(id, .replace, keepResumeData: false)
        }
      }
      persist()
      pump()
    }
  }

  /// The record goes first: later callbacks of its task are stale and never publish (N1-07).
  func cancel(_ id: String) throws {
    try queue.sync { try cancelLocked(id, tombstone: false) }
  }

  /// A cancel outside the app leaves a `cancelled` tombstone until `remove` (fix round 1c); none on iOS yet (Android: notification).
  func cancelOutsideApp(_ id: String) throws {
    try queue.sync { try cancelLocked(id, tombstone: true) }
  }

  private func cancelLocked(_ id: String, tombstone: Bool) throws {
    guard var record = records[id] else { throw notFound(id) }
    if record.state == DownloadStates.cancelled {
      // A tombstone is only forgotten by the app's cancel; its path may belong to a newer download by now.
      if !tombstone {
        records.removeValue(forKey: id)
        order.removeAll { $0 == id }
        persist()
      }
      return
    }
    if tombstone, !record.isActive, record.state != DownloadStates.paused {
      throw EngineError(code: "invalid_state", detail: "download \(id) is \(record.state)")
    }
    // The daemon writes only into its own files: once the record changed, no callback of the old task reaches the path.
    urlTasks[id]?.task.cancel()
    forget(id)
    deleteResumeData(id)
    try? FileManager.default.removeItem(at: stagedFile(id))
    if tombstone {
      record.state = DownloadStates.cancelled
      record.bytesWritten = 0
      record.clearRetry()
      record.error = nil
      record.staged = nil
      record.updatedAt = nowMs
      records[id] = record
      emitState(record)
    } else {
      records.removeValue(forKey: id)
      order.removeAll { $0 == id }
      record.error = DownloadErrorInfo(kind: "cancelled", message: "cancelled")
      emitState(record, state: DownloadStates.cancelled)
    }
    persist()
    pump()
  }

  /// Idempotent: an unknown id is fine.
  func remove(_ id: String) throws {
    try queue.sync {
      guard let record = records[id] else { return }
      if record.isActive || record.state == DownloadStates.paused {
        throw EngineError(code: "invalid_state", detail: "download \(id) is \(record.state)")
      }
      records.removeValue(forKey: id)
      order.removeAll { $0 == id }
      forget(id)
      deleteResumeData(id)
      try? FileManager.default.removeItem(at: stagedFile(id))
      persist()
    }
  }

  /// Drops every pending piece of bookkeeping for an id: late resume data, probes and intents of it are stale (N2-03).
  private func forget(_ id: String) {
    urlTasks.removeValue(forKey: id)
    intents.removeValue(forKey: id)
    awaitingResumeData.removeValue(forKey: id)
    probing.removeValue(forKey: id)
    probed.remove(id)
    endAssertion(id)
    baseline.removeValue(forKey: id)
    lastSpaceCheck.removeValue(forKey: id)
    meters.removeValue(forKey: id)
  }

  /// Strictly increasing across ids, persisted: no new task ever carries a generation an older one had.
  private func nextGeneration(after current: Int) -> Int {
    generationClock = max(generationClock + 1, current + 1, Int(nowMs) * 1000)
    return generationClock
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

  /// Ownership key: `a//b/./c` → `a/b/c`, case-insensitive like the file system.
  static func claimKey(_ volumeId: String, _ relativePath: String) throws -> String {
    let parts = relativePath.split(separator: "/").filter { $0 != "." }
    guard !parts.isEmpty else { throw EngineError(code: "invalid_argument", detail: "empty path") }
    guard !parts.contains("..") else { throw EngineError(code: "invalid_argument", detail: "path escapes the download root: \(relativePath)") }
    return "\(volumeId):\(parts.joined(separator: "/").lowercased())"
  }

  static let stagingSuffix = ".part"

  /// A task's final and staging path (N2-01).
  static func claims(_ key: String) -> [String] { [key, key + stagingSuffix] }

  /// Equal, an ancestor directory or a descendant of either claim.
  static func conflicts(_ record: DownloadRecord, _ others: [String]) -> Bool {
    guard let key = try? claimKey(record.volumeId, record.relativePath) else { return false }
    return claims(key).contains { mine in others.contains { mine == $0 || mine.hasPrefix($0 + "/") || $0.hasPrefix(mine + "/") } }
  }

  /// An unfinished task whose file, partial or directory `relativePath` touches.
  private func liveOwner(_ volumeId: String, _ relativePath: String) throws -> String? {
    let key = try Self.claimKey(volumeId, relativePath)
    return order.first { id in
      guard let record = records[id], record.isActive || urlTasks[id] != nil else { return false }
      return Self.conflicts(record, [key])
    }
  }

  func deletePath(_ relativePath: String, _ volumeId: String?) throws {
    try queue.sync {
      let url = try resolve(relativePath, volumeId)
      if let owner = try liveOwner(volumeId ?? "internal", relativePath) {
        throw EngineError(code: "invalid_state", detail: "\(relativePath) belongs to unfinished download \(owner)")
      }
      if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
  }

  func movePath(_ from: String, _ to: String, _ volumeId: String?) throws {
    try queue.sync {
      for path in [from, to] {
        if let owner = try liveOwner(volumeId ?? "internal", path) {
          throw EngineError(code: "invalid_state", detail: "\(path) belongs to unfinished download \(owner)")
        }
      }
      try move(try resolve(from, volumeId), try resolve(to, volumeId))
    }
  }

  func storage() throws -> [String: Any] {
    ensureRoot()
    let values = try rootURL.resourceValues(forKeys: [.volumeTotalCapacityKey])
    return ["freeBytes": Double(freeBytes()), "totalBytes": Double(values.volumeTotalCapacity ?? 0)]
  }

  /// Capacity for important usage; plain available capacity where a volume does not report that (0/nil).
  func freeBytes() -> Int64 {
    var fresh = rootURL
    fresh.removeAllCachedResourceValues()
    let values = try? fresh.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey])
    if let important = values?.volumeAvailableCapacityForImportantUsage, important > 0 { return important }
    return Int64(values?.volumeAvailableCapacity ?? 0)
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
    Self.syncDirectory(to.deletingLastPathComponent())
    excludeFromBackup(to)
  }

  func excludeFromBackup(_ url: URL) {
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? target.setResourceValues(values)
  }

  /// Covered when the item or a directory above it (up to the root) is excluded; excluding a directory excludes its contents.
  func isExcludedFromBackup(_ url: URL) -> Bool {
    let root = rootURL.standardizedFileURL.path
    var current = url.standardizedFileURL
    while current.path.hasPrefix(root) {
      var fresh = current
      fresh.removeAllCachedResourceValues()
      if (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true { return true }
      if current.path == root { break }
      current.deleteLastPathComponent()
    }
    return false
  }

  /// The root may be removed and recreated by other code (artwork via expo-file-system): recreate and exclude it again.
  func ensureRoot() {
    try? FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
    if !isExcludedFromBackup(rootURL) { excludeFromBackup(rootURL) }
  }

  /// Temp file, fsync, rename, fsync of the directory: the old or the new content survives a crash (N1-15).
  static func writeDurably(_ data: Data, to url: URL) throws {
    let temp = url.appendingPathExtension("tmp")
    FileManager.default.createFile(atPath: temp.path, contents: nil)
    let handle = try FileHandle(forWritingTo: temp)
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    guard rename(temp.path, url.path) == 0 else { throw EngineError(code: "io", detail: "cannot replace \(url.lastPathComponent)") }
    syncDirectory(url.deletingLastPathComponent())
  }

  static func syncDirectory(_ url: URL) {
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else { return }
    fsync(fd)
    close(fd)
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
    var slots = settings.maxConcurrent - urlTasks.count - probing.count
    let now = elapsedMs
    var nextRetry: Double?
    for record in active {
      let id = record.id
      if urlTasks[id] != nil {
        if intents[id] == nil { setState(id, blocked ?? DownloadStates.running) }
        continue
      }
      if awaitingResumeData[id] != nil || probing[id] != nil { continue }
      // A server cooldown is never shortened by a network change (N1-08) nor by the wall clock (N2-04).
      if let due = record.retryDue, due > now {
        setState(id, blocked ?? DownloadStates.retrying)
        nextRetry = min(nextRetry ?? due, due)
        continue
      }
      if slots > 0 {
        begin(id, blocked: blocked)
        slots -= 1
      } else {
        setState(id, blocked ?? DownloadStates.queued)
      }
    }
    retryTimer?.cancel()
    retryTimer = nil
    if let nextRetry {
      let item = DispatchWorkItem { [weak self] in self?.pump() }
      retryTimer = item
      queue.asyncAfter(deadline: .now() + max(0, nextRetry - now) / 1000, execute: item)
    }
    persist()
  }

  /// Remaining bytes of this task and every other running one plus the reserve must fit (N1-16).
  private func spaceFailure(_ id: String, total: Int64?, offset: Int64) -> DownloadErrorInfo? {
    guard let total else { return nil }
    let needed = max(0, total - offset)
    let reserved = urlTasks.keys.filter { $0 != id }.reduce(Int64(0)) { sum, other in
      sum + max(0, (records[other]?.totalBytes ?? 0) - (records[other]?.bytesWritten ?? 0))
    }
    let free = freeBytes()
    guard free - reserved < needed + HttpPolicy.reserveBytes else { return nil }
    return DownloadErrorInfo(kind: "disk_full", message: "needs \(needed) bytes plus a 64 MiB reserve; \(free) free, \(reserved) reserved by other downloads")
  }

  /// HEAD with the task's request: a usable answer lets the resume data be spent on a new GET (N1-10). The probe runs
  /// under a background-task assertion; if that expires the GET is handed to the background session without it.
  private func probe(_ id: String, record: DownloadRecord) {
    guard let url = URL(string: record.url), let session = probeSessions[settings.wifiOnly] else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    record.headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    // A cancel, remove or new start of the id replaces the token: this probe's answer is then stale (N2-03).
    let token = UUID()
    let generation = record.generation
    probing[id] = token
    assertions[id] = BackgroundAssertion("streamarr-download-\(id)") { [weak self] in
      self?.queue.async {
        guard let self, self.probing[id] == token else { return }
        self.probing.removeValue(forKey: id)
        self.probed.insert(id)
        self.pump()
      }
    }
    setState(id, DownloadStates.running)
    session.dataTask(with: request) { [weak self] _, response, error in
      guard let self else { return }
      self.queue.async {
        guard self.probing[id] == token, self.records[id]?.generation == generation else { return }
        self.probing.removeValue(forKey: id)
        defer {
          self.endAssertion(id)
          self.persist()
          self.pump()
        }
        guard self.records[id]?.isActive == true, self.urlTasks[id] == nil else { return }
        if let http = response as? HTTPURLResponse {
          // Servers without HEAD support answer 405/501: let the GET find out.
          if ![405, 501].contains(http.statusCode), let failure = self.statusFailure(http) {
            self.handle(id, failure)
            return
          }
        } else if let error = error as NSError? {
          let info = DownloadErrorInfo(kind: "network", message: "HEAD \(error.domain) \(error.code): \(error.localizedDescription)")
          self.handle(id, Failure(error: info, retryable: true))
          return
        }
        self.probed.insert(id)
      }
    }.resume()
  }

  private func endAssertion(_ id: String) {
    assertions.removeValue(forKey: id)?.end()
  }

  private func begin(_ id: String, blocked: String?) {
    guard var record = records[id] else { return }
    if record.staged == true {
      publishStaged(id)
      return
    }
    guard let session = sessions[settings.wifiOnly], let url = URL(string: record.url), let identifier = session.configuration.identifier else { return }
    let resumeData = loadResumeData(id)
    // Without usable resume data the GET starts at 0: the space check uses that offset (N1-16).
    if let full = spaceFailure(id, total: record.totalBytes, offset: resumeData != nil ? record.bytesWritten : 0) {
      fail(id, full)
      return
    }
    if resumeData != nil, blocked == nil, probed.remove(id) == nil {
      probe(id, record: record)
      return
    }
    let generation = nextGeneration(after: record.generation ?? 0)
    record.generation = generation
    let task: URLSessionDownloadTask
    if let resumeData {
      // The blob stays until the new response is validated: a transient answer must not cost the partial (N1-10).
      task = session.downloadTask(withResumeData: resumeData)
    } else {
      var request = URLRequest(url: url)
      request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      record.headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
      task = session.downloadTask(with: request)
      record.bytesWritten = 0
    }
    task.taskDescription = "\(id)#\(generation)"
    if let total = record.totalBytes { task.countOfBytesClientExpectsToReceive = max(0, total - record.bytesWritten) }
    record.clearRetry()
    records[id] = record
    urlTasks[id] = TaskRef(task: task, session: identifier, generation: generation, fromResumeData: resumeData != nil)
    baseline[id] = record.bytesWritten
    lastSpaceCheck[id] = record.bytesWritten
    setState(id, blocked ?? DownloadStates.running)
    task.resume()
    endAssertion(id)
    persist()
  }

  private func stop(_ id: String, _ intent: StopIntent, keepResumeData: Bool = true) {
    guard let ref = urlTasks[id] else { return }
    intents[id] = intent
    guard keepResumeData else {
      ref.task.cancel()
      return
    }
    // The blob belongs to this generation only: after a cancel or a new start of the id it is dropped (N2-03).
    let generation = ref.generation
    awaitingResumeData[id] = generation
    ref.task.cancel(byProducingResumeData: { [weak self] data in
      guard let self else { return }
      self.queue.async {
        guard self.awaitingResumeData[id] == generation, self.records[id]?.generation == generation else { return }
        if let data { self.saveResumeData(id, data) }
        self.awaitingResumeData.removeValue(forKey: id)
        self.pump()
      }
    })
  }

  private func handle(_ id: String, _ failure: Failure) {
    guard var record = records[id], record.isActive else { return }
    let progress = max(0, record.bytesWritten - (baseline[id] ?? record.bytesWritten))
    if failure.dropPartial {
      deleteResumeData(id)
      record.bytesWritten = 0
      record.etag = nil
      if failure.retryable { record.restarts += 1 }
    }
    record.error = failure.error
    if failure.retryable, path?.status == .unsatisfied {
      if progress > 0 { record.waitingSince = nil }
      records[id] = record
      setState(id, DownloadStates.waitingNetwork)
      return
    }
    let now = elapsedMs
    let decision = HttpPolicy.decideRetry(attempts: record.attempts, waitingSince: record.waitingSince, now: now,
      retryable: failure.retryable, retryAfterMs: failure.retryAfterMs, progressBytes: progress)
    record.attempts = decision.attempts
    record.waitingSince = decision.waitingSince
    if decision.retry, let due = decision.retryAt {
      record.retryDue = due
      record.retryDelay = due - now
      record.retryAt = nowMs + (due - now)
      records[id] = record
      NSLog("[OfflineDownloads] %@: %@, attempt %d, retry in %.0fs", id, failure.error.message, record.attempts, (due - now) / 1000)
      setState(id, DownloadStates.retrying)
    } else {
      records[id] = record
      fail(id, failure.error)
    }
  }

  private func fail(_ id: String, _ error: DownloadErrorInfo) {
    guard var record = records[id] else { return }
    record.error = error
    record.clearRetry()
    records[id] = record
    NSLog("[OfflineDownloads] %@ failed: %@ %@", id, error.kind, error.message)
    setState(id, DownloadStates.failed)
  }

  // MARK: - Validation (N1-06)

  private func statusFailure(_ http: HTTPURLResponse) -> Failure? {
    let status = http.statusCode
    guard !(200..<300).contains(status) else { return nil }
    let retryable = HttpPolicy.retryable(status)
    let wait = retryable ? HttpPolicy.retryAfterMs(http.value(forHTTPHeaderField: "Retry-After")) : nil
    let info = DownloadErrorInfo(kind: "http", message: "HTTP \(status)", httpStatus: status, retryAfterMs: wait)
    return Failure(error: info, retryable: retryable, retryAfterMs: wait, dropPartial: status == 416)
  }

  /// The response must be the pinned/recorded file with the known size; a 206 must continue exactly the bytes the OS kept.
  private func validate(_ task: URLSessionTask, generation: Int, record: inout DownloadRecord) -> Failure? {
    guard let http = task.response as? HTTPURLResponse else { return nil }
    if let failure = statusFailure(http) { return failure }
    let etag = http.value(forHTTPHeaderField: "ETag")
    let strong = HttpPolicy.isStrong(etag) ? etag : nil
    if let pinned = record.expectedEtag, etag != pinned {
      return Failure(error: DownloadErrorInfo(kind: "validator_changed", message: "ETag \(etag ?? "none"), expected \(pinned)"), retryable: false, dropPartial: true)
    }
    if http.statusCode == 206 {
      let range = HttpPolicy.contentRange(http.value(forHTTPHeaderField: "Content-Range"))
      if let range, let expected = record.expectedBytes, range.end == range.total - 1, range.total != expected, strong != nil {
        return Failure(error: DownloadErrorInfo(kind: "size_mismatch", message: "server size \(range.total), expected \(expected)"), retryable: false, dropPartial: true)
      }
      // Proven continuation only (N2-07): the start the OS resumed at and the strong ETag recorded for those bytes.
      let offset = record.resumeOffsetGeneration == generation ? record.resumeOffset : nil
      guard let range, let offset, range.start == offset, range.end == range.total - 1, record.totalBytes.map({ $0 == range.total }) ?? true,
        let strong, let recorded = record.etag, recorded == strong else {
        let detail = "Content-Range \(http.value(forHTTPHeaderField: "Content-Range") ?? "none"), ETag \(etag ?? "none"), resumed at \(offset.map(String.init) ?? "unknown") of \(record.etag ?? "no validator")"
        return Failure(error: DownloadErrorInfo(kind: "network", message: "invalid partial response: \(detail)"), retryable: true, dropPartial: true)
      }
      record.etag = strong
      record.totalBytes = range.total
      return nil
    }
    let length = http.expectedContentLength
    if let expected = record.expectedBytes, length > 0, length != expected {
      return Failure(error: DownloadErrorInfo(kind: "size_mismatch", message: "server size \(length), expected \(expected)"), retryable: false, dropPartial: true)
    }
    if (baseline[record.id] ?? 0) > 0 {
      record.restarts += 1
      baseline[record.id] = 0
      NSLog("[OfflineDownloads] %@: validator changed, starting over", record.id)
    }
    record.etag = strong
    if length > 0 { record.totalBytes = length }
    return nil
  }

  // MARK: - URLSessionDownloadDelegate (engine queue)

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let (id, ref) = current(session, downloadTask), intents[id] == nil, var record = records[id] else { return }
    if record.validatedGeneration != ref.generation {
      if let failure = validate(downloadTask, generation: ref.generation, record: &record) {
        records[id] = record
        stop(id, .failure(failure), keepResumeData: !failure.dropPartial && failure.retryable)
        return
      }
      record.validatedGeneration = ref.generation
      record.error = nil
      if ref.fromResumeData { deleteResumeData(id) }
      records[id] = record
      persist()
    }
    record.bytesWritten = totalBytesWritten
    if totalBytesExpectedToWrite > 0, record.expectedBytes == nil { record.totalBytes = totalBytesExpectedToWrite }
    records[id] = record
    if totalBytesWritten - (lastSpaceCheck[id] ?? 0) >= Self.spaceCheckBytes {
      lastSpaceCheck[id] = totalBytesWritten
      if let full = spaceFailure(id, total: record.totalBytes, offset: totalBytesWritten) {
        stop(id, .failure(Failure(error: full, retryable: false)))
        return
      }
    }
    if blockedState() == nil { setState(id, DownloadStates.running) }
    let now = elapsedMs / 1000
    var meter = meters[id] ?? (at: now, bytes: totalBytesWritten, emitted: 0, speed: 0)
    if now - meter.at >= 0.5 {
      let instant = Double(max(0, totalBytesWritten - meter.bytes)) / (now - meter.at)
      meter.speed = meter.speed == 0 ? instant : meter.speed * 0.7 + instant * 0.3
      meter.at = now
      meter.bytes = totalBytesWritten
    }
    if now - meter.emitted >= 0.5 {
      meter.emitted = now
      emitProgress(["id": id, "bytesWritten": Double(totalBytesWritten), "totalBytes": record.totalBytes.map(Double.init), "bytesPerSecond": meter.speed])
    }
    meters[id] = meter
  }

  /// The OS reuses (or rewinds) its partial file: the 206 that follows must start exactly here (N2-07).
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
    guard let (id, ref) = current(session, downloadTask), var record = records[id] else { return }
    record.resumeOffset = fileOffset
    record.resumeOffsetGeneration = ref.generation
    records[id] = record
    persist()
  }

  /// The one completion path: validated again, published and completed in one step on the engine queue (N1-04/05/06);
  /// a stop requested meanwhile wins over the finished file (N2-08).
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let (id, ref) = current(session, downloadTask) else { return }
    finishedTasks.insert(Self.taskKey(session, downloadTask))
    urlTasks.removeValue(forKey: id)
    meters.removeValue(forKey: id)
    let intent = intents.removeValue(forKey: id)
    awaitingResumeData.removeValue(forKey: id)
    defer {
      persist()
      pump()
    }
    guard var record = records[id] else { return }
    switch intent {
    case .failure(let failure)?:
      // The requested failure stands (e.g. disk_full): the finished file is not published.
      try? FileManager.default.removeItem(at: stagedFile(id))
      record.staged = nil
      records[id] = record
      if failure.dropPartial { deleteResumeData(id) }
      handle(id, failure)
      return
    case .replace?:
      // A new URL or header set replaced the request: the old request's file never becomes this record's file.
      deleteResumeData(id)
      record.bytesWritten = 0
      record.etag = nil
      records[id] = record
      if record.isActive { setState(id, DownloadStates.queued) }
      return
    case .cancel?:
      return
    case .pause?, .requeue?, nil:
      break
    }
    let pausing: Bool
    if case .pause? = intent { pausing = true } else { pausing = false }
    guard record.isActive || pausing else { return }
    let size = ((try? FileManager.default.attributesOfItem(atPath: location.path)[.size]) as? NSNumber)?.int64Value ?? 0
    if let failure = validate(downloadTask, generation: ref.generation, record: &record) ?? finalSizeFailure(size, record: record) {
      records[id] = record
      if pausing {
        if failure.dropPartial {
          deleteResumeData(id)
          records[id]?.bytesWritten = 0
        }
        return
      }
      handle(id, failure)
      return
    }
    record.bytesWritten = size
    record.totalBytes = size
    if pausing {
      // A pending pause wins: the finished file waits in staged/ and resume publishes it.
      do {
        try move(location, stagedFile(id))
        record.staged = true
        deleteResumeData(id)
      } catch {
        NSLog("[OfflineDownloads] %@: cannot stage the finished file: %@", id, error.localizedDescription)
      }
      records[id] = record
      return
    }
    do {
      try move(location, try resolve(record.relativePath, record.volumeId))
    } catch {
      records[id] = record
      let full = (error as NSError).code == NSFileWriteOutOfSpaceError
      handle(id, Failure(error: DownloadErrorInfo(kind: full ? "disk_full" : "file_system", message: error.localizedDescription), retryable: false))
      return
    }
    complete(id, record)
  }

  private func finalSizeFailure(_ size: Int64, record: DownloadRecord) -> Failure? {
    guard let total = record.expectedBytes ?? record.totalBytes, size != total else { return nil }
    return Failure(error: DownloadErrorInfo(kind: "size_mismatch", message: "received \(size) of \(total)"), retryable: false, dropPartial: true)
  }

  private func complete(_ id: String, _ finished: DownloadRecord) {
    var record = finished
    record.attempts = 0
    record.waitingSince = nil
    record.clearRetry()
    record.error = nil
    record.staged = nil
    records[id] = record
    deleteResumeData(id)
    setState(id, DownloadStates.completed)
    emitProgress(["id": id, "bytesWritten": Double(record.bytesWritten), "totalBytes": record.totalBytes.map(Double.init), "bytesPerSecond": 0.0])
  }

  private func publishStaged(_ id: String) {
    guard let record = records[id] else { return }
    do {
      try move(stagedFile(id), try resolve(record.relativePath, record.volumeId))
      complete(id, record)
    } catch {
      records[id]?.staged = nil
      records[id]?.bytesWritten = 0
      handle(id, Failure(error: DownloadErrorInfo(kind: "file_system", message: "staged file: \(error.localizedDescription)"), retryable: true))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if !reconciled { settledEarly.insert(Self.taskKey(session, task)) }
    if finishedTasks.remove(Self.taskKey(session, task)) != nil { return }
    guard let (id, ref) = current(session, task) else { return }
    urlTasks.removeValue(forKey: id)
    meters.removeValue(forKey: id)
    let intent = intents.removeValue(forKey: id)
    let nsError = error as NSError?
    let resumeData = nsError?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    defer {
      persist()
      pump()
    }
    guard records[id] != nil else { return }
    switch intent {
    case .pause?, .requeue?:
      if let resumeData { saveResumeData(id, resumeData) }
      if case .requeue? = intent, records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    case .replace?:
      // The old request's partial is useless for the new one.
      if records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    case .cancel?:
      return
    case .failure(let failure)?:
      if !failure.dropPartial, let resumeData { saveResumeData(id, resumeData) }
      handle(id, failure)
      return
    case nil:
      break
    }
    // Transient errors keep the OS resume data (N1-10).
    if let resumeData { saveResumeData(id, resumeData) }
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
    if ref.fromResumeData, resumeData == nil, nsError.domain == NSURLErrorDomain, (-3007 ... -3000).contains(nsError.code) {
      // The resume data no longer fits the OS's partial file: start over from 0.
      handle(id, Failure(error: DownloadErrorInfo(kind: "network", message: "resume data unusable: \(nsError.code)"), retryable: true, dropPartial: true))
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
    record.updatedAt = nowMs
    records[id] = record
    emitState(record)
  }

  private func emitState(_ record: DownloadRecord, state: String? = nil) {
    var payload = map(record)
    let current = state ?? record.state
    payload["state"] = current
    let event: [String: Any?] = ["id": record.id, "state": current, "task": payload]
    listeners.values.forEach { $0.state(event) }
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
      // Only a wall-clock display of the continuous-clock deadline, recomputed whenever shown (N2-04).
      "retryAt": record.retryDue.map { nowMs + ($0 - elapsedMs) },
      "error": record.error?.map,
      "createdAt": record.createdAt,
      "updatedAt": record.updatedAt,
    ]
  }

  private func checkHeaders(_ headers: [String: String]) throws {
    let rejected = HttpPolicy.disallowedHeaders(headers)
    guard rejected.isEmpty else { throw EngineError(code: "invalid_argument", detail: "headers not allowed: \(rejected.joined(separator: ", "))") }
  }

  private func notFound(_ id: String) -> EngineError { EngineError(code: "not_found", detail: "no download \(id)") }

  private func load() {
    guard let data = try? Data(contentsOf: stateURL), let stored = try? JSONDecoder().decode(StoredState.self, from: data) else { return }
    settings = stored.settings
    generationClock = max(stored.generationClock ?? 0, stored.tasks.compactMap(\.generation).max() ?? 0)
    for var record in stored.tasks {
      restoreWait(&record, stored)
      records[record.id] = record
      order.append(record.id)
    }
  }

  /// Waits persisted on the continuous clock stay on the same boot; otherwise the wall clock may only shorten them (N2-04).
  private func restoreWait(_ record: inout DownloadRecord, _ stored: StoredState) {
    let elapsed = elapsedMs
    let wall = nowMs
    guard let clock = stored.clock, stored.version >= 3 else {
      // Epoch times (state v2): the wall clock is all there is, bounded by the longest wait.
      let remaining = record.retryAt.map { min(max($0 - wall, 0), HttpPolicy.maxRetryAfterMs) }
      record.retryDue = remaining.map { elapsed + $0 }
      record.retryDelay = remaining
      record.waitingSince = record.waitingSince.map { elapsed - min(max(wall - $0, 0), HttpPolicy.maxServerWaitMs) }
      return
    }
    if clock.bootId != nil, clock.bootId == Self.bootId, elapsed >= clock.elapsed { return }
    let restored = record.retryDue.map { due -> (remainingMs: Double, consumedMs: Double) in
      let saved = due - clock.elapsed
      return HttpPolicy.restoreWait(remainingMs: saved, originalMs: record.retryDelay ?? saved, sameBoot: false, elapsedMs: 0, wallMs: wall - clock.wall)
    }
    record.waitingSince = record.waitingSince.map { elapsed - (max(clock.elapsed - $0, 0) + (restored?.consumedMs ?? 0)) }
    record.retryDue = restored.map { elapsed + $0.remainingMs }
  }

  private func persist() {
    let clock = SavedClock(bootId: Self.bootId, elapsed: elapsedMs, wall: nowMs)
    let state = StoredState(settings: settings, tasks: order.compactMap { records[$0] }, clock: clock, generationClock: generationClock)
    guard let data = try? JSONEncoder().encode(state) else { return }
    do {
      try Self.writeDurably(data, to: stateURL)
    } catch {
      NSLog("[OfflineDownloads] cannot save state: %@", error.localizedDescription)
    }
  }

  private func safeName(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id }

  private func resumeFile(_ id: String) -> URL { resumeURL.appendingPathComponent("\(safeName(id)).resume") }

  private func stagedFile(_ id: String) -> URL { stagedURL.appendingPathComponent(safeName(id)) }

  private func saveResumeData(_ id: String, _ data: Data) { try? Self.writeDurably(data, to: resumeFile(id)) }

  private func loadResumeData(_ id: String) -> Data? { try? Data(contentsOf: resumeFile(id)) }

  private func deleteResumeData(_ id: String) { try? FileManager.default.removeItem(at: resumeFile(id)) }
}
#endif
