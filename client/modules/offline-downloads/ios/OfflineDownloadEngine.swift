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
  /// Bytes the engine keeps itself in `kept/` (resume data's OS partial or a clone of it) and their strong ETag (N2-12).
  var keptBytes: Int64?
  var keptEtag: String?
  /// The generation that continues `kept/` with a plain Range request from `rangeOffset` (N2-12).
  var rangeOffset: Int64?
  var rangeGeneration: Int?
  /// The OS temp file name the generation's own resume data gave its task, and that generation (N3-01, fix round 3b).
  var osFileName: String?
  var osFileGeneration: Int?
  /// Identity cycles that failed; after two the task keeps the strict rule: no kept bytes without resume data (3b).
  var identityFailures: Int?

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
  /// The OS partial cannot be proven (a continuation at an unknown offset): it goes, the engine's kept bytes stay (N2-12).
  var unverified = false
}

private enum StopIntent {
  case pause
  /// Same request, another session or slot: a finished file is still this record's file.
  case requeue
  /// A new URL or header set replaced the request (N2-08).
  case replace
  case cancel
  case failure(Failure)
  /// Cancelled for its resume data, resumed from it at once: the blob names the task's OS file (fix round 3b).
  case cycle
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
  private static let counter = NSLock()
  private static var counts = (begun: 0, ended: 0)
  private let lock = NSLock()
  private var live = true
  private var token: Int?

  /// Test seam (N5-03): how many began and ended; every one ends exactly once.
  static var balance: (begun: Int, ended: Int) {
    counter.lock()
    defer { counter.unlock() }
    return counts
  }

  init(_ name: String, expired: @escaping () -> Void) {
    Self.counter.lock()
    Self.counts.begun += 1
    Self.counter.unlock()
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
    let wasLive = live
    live = false
    let raw = token
    token = nil
    lock.unlock()
    guard wasLive else { return }
    Self.counter.lock()
    Self.counts.ended += 1
    Self.counter.unlock()
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
  private let keptURL: URL
  /// Where nsurlsessiond writes this app's in-progress files (undocumented: read only, best effort, N2-12).
  private let osDownloadsURL: URL
  /// Where nsurlsessiond moves a paused task's partial (blobs then carry only its name; iOS 26.5 simulator).
  private let osTempURL: URL
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
  /// The record as persisted before a pause whose resume data is on the way: `paused` reaches disk with its blob (D-01).
  private var pausePending: [String: DownloadRecord] = [:]
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
  /// Per id: the current task's OS file name, its last reported bytes and when they last grew (clone source, N2-12).
  private var osFiles: [String: String] = [:]
  private var taskBytes: [String: Int64] = [:]
  private var lastProgress: [String: Double] = [:]
  private var lastSnapshot: [String: Double] = [:]
  /// Response each id was validated on (generation, status, Content-Range, ETag): a change within a task is validated again.
  private var responseKeys: [String: String] = [:]
  /// Identity cycle in flight per id: the cancelled generation, its start, whether a stop replaced it meanwhile (3b) and
  /// the background time it holds, ended with the cycle on every path (N5-03).
  private final class IdentityCycle {
    let generation: Int
    let startedAt: Double
    var superseded = false
    let assertion: BackgroundAssertion

    init(generation: Int, startedAt: Double, assertion: BackgroundAssertion) {
      self.generation = generation
      self.startedAt = startedAt
      self.assertion = assertion
    }
  }

  private var identityCycles: [String: IdentityCycle] = [:]
  /// The resume-data generation a cycle started and when the cycle began: its first answer must be a 206 (3b).
  private var cycleGenerations: [String: (generation: Int, startedAt: Double)] = [:]
  /// When the current task of an id started or was adopted.
  private var taskStarted: [String: Double] = [:]
  /// The app is in the foreground: identity cycles run only then, and the pending ones on the next activation (3b).
  private var appActive = false
  /// Ids whose Range continuation is being appended to `kept/` (generation); pump leaves them alone.
  private var assembling: [String: Int] = [:]
  private var snapshotTimer: DispatchSourceTimer?
  private var preallocationLogged = false
  private var backgroundHandlers: [String: () -> Void] = [:]
  /// One entry per module instance: a reloaded JS runtime adds its own before the old one is destroyed.
  private var listeners: [ObjectIdentifier: Listener] = [:]
  private var retryTimer: DispatchWorkItem?
  private var activated = false
  private var reconciled = false
  private let monitor = NWPathMonitor()
  private var path: NWPath?

  private static let spaceCheckBytes: Int64 = 64 * 1024 * 1024
  private static let snapshotBytes: Int64 = 64 * 1024 * 1024
  private static let cycleMinBytes: Int64 = 1 << 20
  private static let cycleMinMs = 2000.0
  private static let maxIdentityFailures = 2

  private override init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    rootURL = support.appendingPathComponent("downloads", isDirectory: true)
    supportURL = support.appendingPathComponent("offline-downloads", isDirectory: true)
    stateURL = supportURL.appendingPathComponent("state.json")
    resumeURL = supportURL.appendingPathComponent("resume", isDirectory: true)
    stagedURL = supportURL.appendingPathComponent("staged", isDirectory: true)
    keptURL = supportURL.appendingPathComponent("kept", isDirectory: true)
    let osRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    osDownloadsURL = osRoot.appendingPathComponent("com.apple.nsurlsessiond/Downloads", isDirectory: true)
      .appendingPathComponent(Bundle.main.bundleIdentifier ?? "dev.streamarr.app", isDirectory: true)
    osTempURL = FileManager.default.temporaryDirectory
    super.init()
  }

  private var sessionPrefix: String { (Bundle.main.bundleIdentifier ?? "dev.streamarr.app") + ".offline-downloads" }

  private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

  private static let timebase: (numer: Double, denom: Double) = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return (Double(info.numer), Double(info.denom))
  }()

  /// Sleep-inclusive ms since boot, like CLOCK_MONOTONIC(_RAW); CLOCK_UPTIME_RAW, systemUptime, SuspendingClock stop (N2-04).
  private var continuousMs: () -> Double = { OfflineDownloadEngine.continuousNow() }

  static func continuousNow() -> Double {
    Double(mach_continuous_time()) * timebase.numer / timebase.denom / 1_000_000
  }

  private static let processBootId = "process-\(UUID().uuidString)"

  /// The engine clock for JS (C2-07): sleep-inclusive ms since boot and the N2-04 boot id (a per-process one if unknown).
  static func clock() -> [String: Any] {
    ["elapsedMs": continuousNow(), "bootId": bootId ?? processBootId]
  }

  /// Every wait and budget runs on it.
  private var elapsedMs: Double { continuousMs() }

  /// The engine log; a test seam for the diagnostics lines.
  private var diagnostic: (String) -> Void = { NSLog("[OfflineDownloads] %@", $0) }

  /// DispatchTime stops in sleep: a retry wake-up re-arms at least this often and decides on elapsedMs (N2-04).
  private var maxWakeMs = 60_000.0

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
      for url in [rootURL, supportURL, resumeURL, stagedURL, keptURL] {
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
      observeForeground()
      reconcile()
    }
  }

  private func observeForeground() {
    #if canImport(UIKit)
      let center = NotificationCenter.default
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.queue.async { self?.setAppActive(true) } }
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.queue.async { self?.setAppActive(false) } }
      DispatchQueue.main.async { [weak self] in
        let active = UIApplication.shared.applicationState == .active
        self?.queue.async { self?.setAppActive(active) }
      }
    #endif
  }

  /// A cycle that came due while the app was in the background runs now.
  private func setAppActive(_ active: Bool) {
    appActive = active
    if active { for id in Array(urlTasks.keys) { maybeCycleIdentity(id) } }
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
    // A response validated before the relaunch is the same response: finishing it is no restart.
    baseline[id] = record.validatedGeneration == generation ? 0 : record.bytesWritten
    lastSpaceCheck[id] = record.bytesWritten
    taskStarted[id] = elapsedMs
    // The persisted identity holds for the same task while its file is still there; otherwise a cycle learns it again (3b).
    if record.osFileGeneration == generation, let name = record.osFileName, FileManager.default.fileExists(atPath: osPartial(name).path) {
      osFiles[id] = name
    } else if record.osFileName != nil {
      setIdentity(id, nil, generation: nil)
    }
    startSnapshotTimer()
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
      try Self.requirePortable(relativePath)
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
      let persisted = record
      stop(id, .pause)
      if awaitingResumeData[id] != nil { pausePending[id] = persisted }
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
      guard !Self.hasEmptySegment(record.relativePath) else { throw EngineError(code: "invalid_argument", detail: "\(Self.invalidLegacyPath): remove \(id)") }
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
        // Resume data stays: begin() continues its bytes with a Range request when the URL changed (N2-12).
        setState(id, DownloadStates.queued)
      } else {
        records[id] = record
        if changedRequest, urlTasks[id] != nil { stop(id, .replace) }
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
    clearKept(&record)
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
      removeKeptFiles(id)
      persist()
    }
  }

  /// Drops every pending piece of bookkeeping for an id: late resume data, probes and intents of it are stale (N2-03).
  private func forget(_ id: String) {
    urlTasks.removeValue(forKey: id)
    intents.removeValue(forKey: id)
    awaitingResumeData.removeValue(forKey: id)
    pausePending.removeValue(forKey: id)
    probing.removeValue(forKey: id)
    probed.remove(id)
    endAssertion(id)
    baseline.removeValue(forKey: id)
    lastSpaceCheck.removeValue(forKey: id)
    meters.removeValue(forKey: id)
    clearTaskTracking(id)
    assembling.removeValue(forKey: id)
    dropCycle(id)
  }

  private func clearTaskTracking(_ id: String) {
    osFiles.removeValue(forKey: id)
    taskBytes.removeValue(forKey: id)
    lastProgress.removeValue(forKey: id)
    lastSnapshot.removeValue(forKey: id)
    responseKeys.removeValue(forKey: id)
    cycleGenerations.removeValue(forKey: id)
    taskStarted.removeValue(forKey: id)
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

  /// Ownership key: `a//b/./c` → `a/b/c`, case-insensitive and without trailing dots/spaces, like Android's FAT/exFAT media.
  static func claimKey(_ volumeId: String, _ relativePath: String) throws -> String {
    let parts = relativePath.split(separator: "/").filter { $0 != "." }
    guard !parts.isEmpty else { throw EngineError(code: "invalid_argument", detail: "empty path") }
    guard !parts.contains("..") else { throw EngineError(code: "invalid_argument", detail: "path escapes the download root: \(relativePath)") }
    let stripped = parts.map { String($0.reversed().drop { $0 == "." || $0 == " " }.reversed()) }
    guard !stripped.contains(where: \.isEmpty) else { throw EngineError(code: "invalid_argument", detail: "empty path segment: \(relativePath)") }
    return "\(volumeId):\(stripped.joined(separator: "/").lowercased())"
  }

  /// A segment ending in a dot or space would alias another name on FAT/exFAT media; the rule is the same on every platform (N3-03).
  static func requirePortable(_ relativePath: String) throws {
    if relativePath.split(separator: "/").contains(where: { $0 != "." && ($0.hasSuffix(".") || $0.hasSuffix(" ")) }) {
      throw EngineError(code: "invalid_argument", detail: "a path segment may not end in a dot or space: \(relativePath)")
    }
  }

  static let stagingSuffix = ".part"

  /// A task's final and staging path (N2-01).
  static func claims(_ key: String) -> [String] { [key, key + stagingSuffix] }

  static let invalidLegacyPath = "invalid_legacy_path"

  /// A segment of only dots or spaces (accepted before N3-03, dev installs only).
  static func hasEmptySegment(_ relativePath: String) -> Bool {
    relativePath.split(separator: "/").contains { $0 != "." && $0 != ".." && $0.allSatisfy { $0 == "." || $0 == " " } }
  }

  /// Such a legacy path owns the folder before that segment (none at the top), so no parent delete reaches it (N4-03).
  static func legacyClaimKey(_ volumeId: String, _ relativePath: String) -> String? {
    let stripped = relativePath.split(separator: "/").filter { $0 != "." }.map { String($0.reversed().drop { $0 == "." || $0 == " " }.reversed()) }
    let prefix = Array(stripped.prefix { !$0.isEmpty })
    return prefix.isEmpty ? nil : "\(volumeId):\(prefix.joined(separator: "/").lowercased())"
  }

  /// Equal, an ancestor directory or a descendant of either claim.
  static func conflicts(_ record: DownloadRecord, _ others: [String]) -> Bool {
    let mine = (try? claimKey(record.volumeId, record.relativePath)).map(claims) ?? legacyClaimKey(record.volumeId, record.relativePath).map { [$0] } ?? []
    return mine.contains { mine in others.contains { mine == $0 || mine.hasPrefix($0 + "/") || $0.hasPrefix(mine + "/") } }
  }

  /// Any registered task but a completed one or a tombstone (paused, failed too) whose path `relativePath` touches (N3-02).
  private func liveOwner(_ volumeId: String, _ relativePath: String) throws -> String? {
    let key = try Self.claimKey(volumeId, relativePath)
    return order.first { id in
      guard let record = records[id], record.state != DownloadStates.cancelled, record.state != DownloadStates.completed else { return false }
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
    var slots = settings.maxConcurrent - urlTasks.count - probing.count - identityCycles.keys.filter { urlTasks[$0] == nil }.count
    let now = elapsedMs
    var nextRetry: Double?
    for record in active {
      let id = record.id
      if urlTasks[id] != nil {
        if intents[id] == nil { setState(id, blocked ?? DownloadStates.running) }
        continue
      }
      if awaitingResumeData[id] != nil || probing[id] != nil || assembling[id] != nil || identityCycles[id] != nil { continue }
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
      queue.asyncAfter(deadline: .now() + min(max(0, nextRetry - now), maxWakeMs) / 1000, execute: item)
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

  /// The cycle ends here with its background time, whatever ended it (finished file, cancel, remove, new start).
  @discardableResult
  private func dropCycle(_ id: String) -> IdentityCycle? {
    let cycle = identityCycles.removeValue(forKey: id)
    cycle?.assertion.end()
    return cycle
  }

  private func begin(_ id: String, blocked: String?) {
    guard var record = records[id] else { return }
    if record.staged == true {
      publishStaged(id)
      return
    }
    guard let session = sessions[settings.wifiOnly], let url = URL(string: record.url), let identifier = session.configuration.identifier else { return }
    var resumeData = usableResumeData(id)
    // Resume data is bound to its request: another URL continues the same bytes with a plain Range request (N2-12).
    if let data = resumeData, let info = Self.resumeInfo(data), info.url != nil, info.url != record.url {
      if keepFromResumeData(id, data) { record = records[id] ?? record }
      deleteResumeData(id)
      resumeData = nil
    }
    let kept = resumeData == nil ? keptLength(record) : nil
    if resumeData == nil, kept == nil, record.keptBytes != nil { clearKept(&record) }
    // Without usable resume data or kept bytes the GET starts at 0: the space check uses that offset (N1-16); a Range
    // continuation needs room for its remainder twice while it is appended to the kept bytes.
    let offset = resumeData != nil ? record.bytesWritten : (kept ?? 0)
    let total = record.totalBytes.map { kept != nil ? $0 + max(0, $0 - offset) : $0 }
    if let full = spaceFailure(id, total: total, offset: offset) {
      fail(id, full)
      return
    }
    if resumeData != nil, blocked == nil, probed.remove(id) == nil {
      probe(id, record: record)
      return
    }
    let generation = nextGeneration(after: record.generation ?? 0)
    record.generation = generation
    clearTaskTracking(id)
    let task: URLSessionDownloadTask
    if let resumeData {
      // The blob stays until the new response is validated: a transient answer must not cost the partial (N1-10). Its
      // bytes are cloned first: a 4xx/5xx answer to the GET makes the OS truncate that file (N2-12).
      keepFromResumeData(id, resumeData)
      record = records[id] ?? record
      record.generation = generation
      task = session.downloadTask(withResumeData: resumeData)
      let name = Self.resumeInfo(resumeData)?.tempName
      osFiles[id] = name
      record.osFileName = name
      record.osFileGeneration = name.map { _ in generation }
    } else {
      record.osFileName = nil
      record.osFileGeneration = nil
      var request = URLRequest(url: url)
      request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      record.headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
      if let kept, let etag = record.keptEtag {
        request.setValue("bytes=\(kept)-", forHTTPHeaderField: "Range")
        request.setValue(etag, forHTTPHeaderField: "If-Range")
        record.rangeOffset = kept
        record.rangeGeneration = generation
        record.etag = etag
        record.bytesWritten = kept
      } else {
        record.rangeOffset = nil
        record.rangeGeneration = nil
        // Neither resume data nor kept bytes: what the record still counted starts over (D-02).
        dropBytes(&record, keeping: 0)
      }
      task = session.downloadTask(with: request)
    }
    task.taskDescription = "\(id)#\(generation)"
    if let total = record.totalBytes { task.countOfBytesClientExpectsToReceive = max(0, total - record.bytesWritten) }
    record.clearRetry()
    records[id] = record
    urlTasks[id] = TaskRef(task: task, session: identifier, generation: generation, fromResumeData: resumeData != nil)
    baseline[id] = record.bytesWritten
    lastSpaceCheck[id] = record.bytesWritten
    taskStarted[id] = elapsedMs
    setState(id, blocked ?? DownloadStates.running)
    task.resume()
    endAssertion(id)
    startSnapshotTimer()
    persist()
  }

  private func stop(_ id: String, _ intent: StopIntent, keepResumeData: Bool = true) {
    guard let ref = urlTasks[id] else { return }
    intents[id] = intent
    // The task is already being cancelled for its resume data: that blob serves this stop too (3b).
    if identityCycles[id] != nil {
      identityCycles[id]?.superseded = true
      return
    }
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
        if let data, self.records[id]?.rangeGeneration != generation { self.saveResumeData(id, data) }
        self.awaitingResumeData.removeValue(forKey: id)
        self.pausePending.removeValue(forKey: id)
        self.pump()
      }
    })
  }

  private func handle(_ id: String, _ failure: Failure) {
    guard var record = records[id], record.isActive else { return }
    let progress = max(0, record.bytesWritten - (baseline[id] ?? record.bytesWritten))
    if failure.dropPartial {
      deleteResumeData(id)
      clearKept(&record)
      dropBytes(&record, keeping: 0)
      record.etag = nil
    } else if !failure.unverified, let data = usableResumeData(id) {
      if let info = Self.resumeInfo(data) { record.bytesWritten = info.bytes }
    } else {
      if failure.unverified { deleteResumeData(id) }
      // Without resume data only the engine's own copy survives; an error body never counts as bytes (N2-12).
      dropBytes(&record, keeping: keptLength(record) ?? 0)
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
  /// `validatedKey`: the answer of this generation that passed before; another one is the OS retrying inside the task.
  private func validate(_ task: URLSessionTask, generation: Int, record: inout DownloadRecord, validatedKey: String? = nil) -> Failure? {
    guard let http = task.response as? HTTPURLResponse else { return nil }
    // Background sessions follow redirects on their own; bytes an https request got over http are never published (N1-12).
    if URL(string: record.url)?.scheme?.lowercased() == "https", http.url?.scheme?.lowercased() == "http" {
      return Failure(error: DownloadErrorInfo(kind: "network", message: "redirect https → http refused"), retryable: false, dropPartial: true)
    }
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
      // Proven continuation only (N2-07): the start the OS resumed at (didResumeAtOffset, else the Range on the task's
      // current request: the engine's own Range continuation or the OS retrying inside the task) and the strong ETag
      // recorded for those bytes.
      let requested = Self.requestedStart(task)
      let ownRange = record.rangeGeneration == generation
      let seen = record.validatedGeneration == generation
      let key = Self.responseKey(task, generation)
      // An OS retry inside the task appends where its own Range says; the generation's first offset is stale for it (3b).
      let later = seen && validatedKey != nil && validatedKey != key
      let offset: Int64?
      if seen, validatedKey == key {
        offset = range?.start
      } else if later {
        offset = requested
      } else if ownRange {
        offset = requested.flatMap { $0 >= (record.rangeOffset ?? 0) ? $0 : nil } ?? record.rangeOffset
      } else {
        offset = (record.resumeOffsetGeneration == generation ? record.resumeOffset : nil) ?? requested
      }
      let recorded = ownRange ? record.keptEtag : record.etag
      let consistent = range.map { span in span.end == span.total - 1 && (record.totalBytes.map { $0 == span.total } ?? true) } ?? false
      guard let range, let offset, range.start == offset, consistent, let strong, let recorded, recorded == strong else {
        let detail = "Content-Range \(http.value(forHTTPHeaderField: "Content-Range") ?? "none"), ETag \(etag ?? "none"), resumed at \(offset.map(String.init) ?? "unknown") of \(record.etag ?? "no validator")"
        // The OS retried inside the task and does not say where it appended: only the engine's own copy can be proven.
        // An unproven append costs only the OS file: the engine's own copy stays (N2-12, 3b).
        let unverified = ((offset == nil && !ownRange) || (seen && validatedKey != key)) && consistent && strong != nil && strong == recorded
        return Failure(error: DownloadErrorInfo(kind: "network", message: "\(unverified ? "unverifiable" : "invalid") partial response: \(detail)"),
          retryable: true, dropPartial: !unverified, unverified: unverified)
      }
      record.etag = strong
      record.totalBytes = range.total
      return nil
    }
    // If-Range did not match: the server sent the whole (changed) file and the kept bytes are worthless (N2-12).
    if record.rangeGeneration == generation { clearKept(&record) }
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
    // A non-2xx body is never task content: it is not counted, the task fails and the kept bytes stay (N2-12).
    if let http = downloadTask.response as? HTTPURLResponse, let failure = statusFailure(http) {
      stop(id, .failure(failure), keepResumeData: false)
      return
    }
    // Validated once per generation, and again when the OS switched to another response inside the task.
    let key = Self.responseKey(downloadTask, ref.generation)
    if record.validatedGeneration != ref.generation || (responseKeys[id] != nil && responseKeys[id] != key) {
      let first = record.validatedGeneration != ref.generation
      if let failure = validate(downloadTask, generation: ref.generation, record: &record, validatedKey: responseKeys[id]) {
        records[id] = record
        if cycleGenerations[id]?.generation == ref.generation { identityFailed(id, failure.error.message) }
        stop(id, .failure(failure), keepResumeData: !failure.dropPartial && !failure.unverified && failure.retryable)
        return
      }
      record.validatedGeneration = ref.generation
      record.error = nil
      if ref.fromResumeData { deleteResumeData(id) }
      records[id] = record
      if ref.fromResumeData {
        confirmIdentity(id, ref, downloadTask, first: first)
        record = records[id] ?? record
      }
      persist()
    }
    responseKeys[id] = key
    if totalBytesWritten > (taskBytes[id] ?? -1) { lastProgress[id] = elapsedMs }
    taskBytes[id] = totalBytesWritten
    let written = (record.rangeGeneration == ref.generation ? record.rangeOffset ?? 0 : 0) + totalBytesWritten
    record.bytesWritten = written
    if totalBytesExpectedToWrite > 0, record.expectedBytes == nil, record.rangeGeneration != ref.generation { record.totalBytes = totalBytesExpectedToWrite }
    records[id] = record
    if written - (lastSpaceCheck[id] ?? 0) >= Self.spaceCheckBytes {
      lastSpaceCheck[id] = written
      if let full = spaceFailure(id, total: record.totalBytes, offset: written) {
        stop(id, .failure(Failure(error: full, retryable: false)))
        return
      }
    }
    if totalBytesWritten - (record.keptBytes ?? 0) >= Self.snapshotBytes { snapshot(id) }
    if blockedState() == nil { setState(id, DownloadStates.running) }
    defer { maybeCycleIdentity(id) }
    let now = elapsedMs / 1000
    var meter = meters[id] ?? (at: now, bytes: written, emitted: 0, speed: 0)
    if now - meter.at >= 0.5 {
      let instant = Double(max(0, written - meter.bytes)) / (now - meter.at)
      meter.speed = meter.speed == 0 ? instant : meter.speed * 0.7 + instant * 0.3
      meter.at = now
      meter.bytes = written
    }
    if now - meter.emitted >= 0.5 {
      meter.emitted = now
      emitProgress(["id": id, "bytesWritten": Double(written), "totalBytes": record.totalBytes.map(Double.init), "bytesPerSecond": meter.speed])
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
    // A non-2xx body is never task content: at most a redacted, truncated line in the log (N2-12, N3-07).
    if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      let limit = HttpPolicy.diagnosticReadBytes
      let head = (try? FileHandle(forReadingFrom: location)).flatMap { handle in defer { try? handle.close() }; return try? handle.read(upToCount: limit + 1) }
      let urls = [records[id]?.url, downloadTask.originalRequest?.url?.absoluteString, downloadTask.currentRequest?.url?.absoluteString, http.url?.absoluteString]
      let line = HttpPolicy.diagnosticLine(status: http.statusCode, contentType: http.value(forHTTPHeaderField: "Content-Type"),
        length: http.expectedContentLength, body: head?.prefix(limit), cut: (head?.count ?? 0) > limit, requestUrls: urls.compactMap { $0 })
      diagnostic("\(id): \(line)")
    }
    finishedTasks.insert(Self.taskKey(session, downloadTask))
    urlTasks.removeValue(forKey: id)
    meters.removeValue(forKey: id)
    let validatedKey = responseKeys[id]
    clearTaskTracking(id)
    var intent = intents.removeValue(forKey: id)
    awaitingResumeData.removeValue(forKey: id)
    pausePending.removeValue(forKey: id)
    // Finished before the cancel for the resume data took effect: the file is simply done.
    if dropCycle(id) != nil, case .cycle? = intent { intent = nil }
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
      dropBytes(&record, keeping: keptLength(record) ?? 0)
      if record.keptBytes == nil { record.etag = nil }
      records[id] = record
      if record.isActive { setState(id, DownloadStates.queued) }
      return
    case .cancel?:
      return
    case .pause?, .requeue?, .cycle?, nil:
      break
    }
    let pausing: Bool
    if case .pause? = intent { pausing = true } else { pausing = false }
    guard record.isActive || pausing else { return }
    let size = fileSize(location) ?? 0
    var failure = validate(downloadTask, generation: ref.generation, record: &record, validatedKey: validatedKey)
    // An own Range continuation holds only the bytes after the kept ones (N2-12).
    let base = record.rangeGeneration == ref.generation ? record.rangeOffset ?? 0 : 0
    if failure == nil { failure = finalSizeFailure(base + size, record: record) }
    if let failure {
      records[id] = record
      if pausing {
        if failure.dropPartial || failure.unverified {
          deleteResumeData(id)
          if failure.dropPartial { clearKept(&record) }
          dropBytes(&record, keeping: keptLength(record) ?? 0)
          records[id] = record
        }
        return
      }
      handle(id, failure)
      return
    }
    if base > 0 {
      assemble(id, generation: ref.generation, tail: location, size: base + size, pausing: pausing, record: record)
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
    clearKept(&record)
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
    let meter = meters.removeValue(forKey: id)
    clearTaskTracking(id)
    let intent = intents.removeValue(forKey: id)
    let nsError = error as NSError?
    // A Range continuation's resume data covers only the remainder file: its kept bytes are what survives (N2-12).
    let resumeData = records[id]?.rangeGeneration == ref.generation ? nil : nsError?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    defer {
      persist()
      pump()
    }
    guard records[id] != nil else { return }
    switch intent {
    case .cycle?:
      // The cycle resumes from this blob (or the one its cancel hands over): no state, progress or restart changes.
      if let resumeData { saveResumeData(id, resumeData) }
      meters[id] = meter
      return
    case .pause?, .requeue?:
      if let resumeData { saveResumeData(id, resumeData) }
      pausePending.removeValue(forKey: id)
      if case .requeue? = intent, records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    case .replace?:
      // begin() continues the old request's bytes for the new URL with a Range request (N2-12).
      if let resumeData { saveResumeData(id, resumeData) }
      if records[id]?.isActive == true { setState(id, DownloadStates.queued) }
      return
    case .cancel?:
      return
    case .failure(let failure)?:
      if !failure.dropPartial, !failure.unverified, let resumeData { saveResumeData(id, resumeData) }
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
      if record.state != DownloadStates.cancelled, Self.hasEmptySegment(record.relativePath) {
        record.state = DownloadStates.failed
        record.clearRetry()
        record.error = DownloadErrorInfo(kind: "file_system", message: Self.invalidLegacyPath)
        NSLog("[OfflineDownloads] %@: %@ %@", record.id, Self.invalidLegacyPath, record.relativePath)
      }
      if record.keptBytes != nil, keptLength(record) == nil { clearKept(&record) }
      records[record.id] = record
      order.append(record.id)
    }
    let owners = Set(records.keys.map(safeName))
    for name in (try? FileManager.default.contentsOfDirectory(atPath: keptURL.path)) ?? [] where !owners.contains(String(name.prefix { $0 != "." })) {
      try? FileManager.default.removeItem(at: keptURL.appendingPathComponent(name))
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
    let state = StoredState(settings: settings, tasks: order.compactMap { pausePending[$0] ?? records[$0] }, clock: clock, generationClock: generationClock)
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

  /// The OS partial behind the blob is cloned at once: nsurlsessiond may purge it before the resume (seen on the simulator).
  private func saveResumeData(_ id: String, _ data: Data) {
    try? Self.writeDurably(data, to: resumeFile(id))
    keepFromResumeData(id, data)
  }

  private func loadResumeData(_ id: String) -> Data? { try? Data(contentsOf: resumeFile(id)) }

  private func deleteResumeData(_ id: String) { try? FileManager.default.removeItem(at: resumeFile(id)) }

  // MARK: - Identity cycle (fix round 3b)

  /// A fresh GET has no exact OS-file identity (N3-01). Once validated, at least 1 MiB in and 2 s old, it is cancelled for
  /// its resume data and resumed from it at once: the blob names its file. Only in the foreground, at most two failures.
  private func maybeCycleIdentity(_ id: String) {
    guard appActive, let ref = urlTasks[id], intents[id] == nil, !ref.fromResumeData, identityCycles[id] == nil, osFiles[id] == nil,
      let record = records[id], record.isActive, record.rangeGeneration != ref.generation, record.validatedGeneration == ref.generation,
      (record.identityFailures ?? 0) < Self.maxIdentityFailures, HttpPolicy.isStrong(record.etag),
      let http = ref.task.response as? HTTPURLResponse, http.statusCode == 200,
      http.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased().contains("bytes") == true,
      let written = taskBytes[id], written >= Self.cycleMinBytes, elapsedMs - (taskStarted[id] ?? elapsedMs) >= Self.cycleMinMs,
      record.totalBytes.map({ $0 - written >= Self.cycleMinBytes }) ?? true else { return }
    let generation = ref.generation
    intents[id] = .cycle
    awaitingResumeData[id] = generation
    // Until the resumed task runs: a cancelled task with no successor would wait for the next launch.
    identityCycles[id] = IdentityCycle(generation: generation, startedAt: elapsedMs, assertion: BackgroundAssertion("streamarr-download-\(id)") {})
    ref.task.cancel(byProducingResumeData: { [weak self] data in
      guard let self else { return }
      self.queue.async { self.finishIdentityCycle(id, generation, data) }
    })
  }

  private func finishIdentityCycle(_ id: String, _ generation: Int, _ data: Data?) {
    guard let cycle = identityCycles[id], cycle.generation == generation, records[id]?.generation == generation else { return }
    identityCycles.removeValue(forKey: id)
    if awaitingResumeData[id] == generation { awaitingResumeData.removeValue(forKey: id) }
    defer {
      // After begin() handed the bytes to the resumed task (or the cycle gave up): the background time is not needed.
      cycle.assertion.end()
      persist()
      pump()
    }
    let blob = data ?? loadResumeData(id)
    if let blob { saveResumeData(id, blob) }
    pausePending.removeValue(forKey: id)
    // A stop (pause, requeue, new URL) or a pause after the old task ended takes over with the saved blob.
    guard !cycle.superseded, records[id]?.isActive == true else { return }
    intents.removeValue(forKey: id)
    urlTasks.removeValue(forKey: id)
    let started = cycle.startedAt
    guard let blob, let info = Self.resumeInfo(blob), info.etag == records[id]?.etag, usableResumeData(id) != nil else {
      identityFailed(id, blob == nil ? "no resume data" : "unusable resume data")
      deleteResumeData(id)
      // The cancelled task's bytes are gone unless the engine kept them: an honest restart.
      if var record = records[id] {
        dropBytes(&record, keeping: keptLength(record) ?? 0)
        records[id] = record
      }
      begin(id, blocked: blockedState())
      return
    }
    probed.insert(id)
    begin(id, blocked: blockedState())
    if let ref = urlTasks[id], ref.fromResumeData { cycleGenerations[id] = (ref.generation, started) }
  }

  /// A resume-data generation keeps its file name only when its first answer continues those bytes (206).
  private func confirmIdentity(_ id: String, _ ref: TaskRef, _ task: URLSessionDownloadTask, first: Bool) {
    guard let http = task.response as? HTTPURLResponse else { return }
    let cycle = cycleGenerations[id]?.generation == ref.generation ? cycleGenerations.removeValue(forKey: id) : nil
    guard http.statusCode == 206 else {
      if cycle != nil { identityFailed(id, "the resumed task got HTTP \(http.statusCode)") } else { setIdentity(id, nil, generation: nil) }
      return
    }
    if first, let cycle, let name = osFiles[id] {
      let offset = records[id]?.resumeOffsetGeneration == ref.generation ? records[id]?.resumeOffset : nil
      diagnostic("\(id): identity cycle: \(name) at \(offset.map(String.init) ?? "?") bytes, resumed with a 206 after \(Int(elapsedMs - cycle.startedAt)) ms")
    }
  }

  private func identityFailed(_ id: String, _ reason: String) {
    cycleGenerations.removeValue(forKey: id)
    setIdentity(id, nil, generation: nil)
    guard var record = records[id] else { return }
    record.identityFailures = (record.identityFailures ?? 0) + 1
    records[id] = record
    diagnostic("\(id): identity cycle failed (\(reason)), \(record.identityFailures ?? 0) of \(Self.maxIdentityFailures): without resume data nothing is kept")
  }

  private func setIdentity(_ id: String, _ name: String?, generation: Int?) {
    if let name { osFiles[id] = name } else { osFiles.removeValue(forKey: id) }
    records[id]?.osFileName = name
    records[id]?.osFileGeneration = name == nil ? nil : generation
  }

  // MARK: - Kept bytes (N2-12)

  private func keptFile(_ id: String) -> URL { keptURL.appendingPathComponent(safeName(id)) }

  /// One continuation per generation: a late completion of an older one never touches the current tail (N3-09).
  private func tailFile(_ id: String, _ generation: Int) -> URL { keptURL.appendingPathComponent("\(safeName(id)).\(generation).tail") }

  private func fileSize(_ url: URL) -> Int64? { ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value }

  /// The kept byte count when the file holds exactly that many bytes and a strong ETag belongs to them.
  private func keptLength(_ record: DownloadRecord) -> Int64? {
    guard let kept = record.keptBytes, kept > 0, record.keptEtag.map(HttpPolicy.isStrong) == true, fileSize(keptFile(record.id)) == kept else { return nil }
    return kept
  }

  private func removeKeptFiles(_ id: String) {
    for suffix in ["", ".tail", ".new"] { try? FileManager.default.removeItem(at: URL(fileURLWithPath: keptFile(id).path + suffix)) }
    let tails = (try? FileManager.default.contentsOfDirectory(atPath: keptURL.path))?.filter { $0.hasPrefix(safeName(id) + ".") && $0.hasSuffix(".tail") }
    for name in tails ?? [] { try? FileManager.default.removeItem(at: keptURL.appendingPathComponent(name)) }
  }

  /// The bytes that cannot continue go back to the kept ones; losing every one of them is one restart (D-02).
  private func dropBytes(_ record: inout DownloadRecord, keeping kept: Int64) {
    if kept == 0, record.bytesWritten > 0 {
      record.restarts += 1
      NSLog("[OfflineDownloads] %@: %lld bytes cannot continue, starting over", record.id, record.bytesWritten)
    }
    record.bytesWritten = kept
  }

  private func clearKept(_ record: inout DownloadRecord) {
    removeKeptFiles(record.id)
    record.keptBytes = nil
    record.keptEtag = nil
    record.rangeOffset = nil
    record.rangeGeneration = nil
  }

  /// Resume data whose OS file still holds its bytes; the OS truncates that file when a GET from it gets an error.
  private func usableResumeData(_ id: String) -> Data? {
    guard let data = loadResumeData(id) else { return nil }
    if let info = Self.resumeInfo(data), (fileSize(info.path ?? osPartial(info.tempName)) ?? 0) < info.bytes {
      deleteResumeData(id)
      return nil
    }
    return data
  }

  /// What a resume-data blob says about the OS partial (undocumented keys; nil when unreadable).
  static func resumeInfo(_ data: Data) -> (tempName: String, path: URL?, bytes: Int64, etag: String?, url: String?)? {
    guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
    unarchiver.requiresSecureCoding = false
    defer { unarchiver.finishDecoding() }
    // Device blobs (iOS 26.5) use the literal "NSKeyedArchiveRootObjectKey" as root key, not NSKeyedArchiveRootObjectKey ("root").
    guard let info = (unarchiver.decodeObject(forKey: "NSKeyedArchiveRootObjectKey") ?? unarchiver.decodeObject(forKey: NSKeyedArchiveRootObjectKey)) as? [String: Any],
      let bytes = (info["NSURLSessionResumeBytesReceived"] as? NSNumber)?.int64Value else { return nil }
    let local = (info["NSURLSessionResumeInfoLocalPath"] as? String).map { URL(fileURLWithPath: $0) }
    guard let name = (info["NSURLSessionResumeInfoTempFileName"] as? String) ?? local?.lastPathComponent, !name.contains("/") else { return nil }
    return (name, local, bytes, info["NSURLSessionResumeEntityTag"] as? String, info["NSURLSessionDownloadURL"] as? String)
  }

  /// The OS partial a resume-data blob points at, kept as a clone: its bytes survive a new URL or a failed GET.
  @discardableResult
  private func keepFromResumeData(_ id: String, _ data: Data) -> Bool {
    guard let record = records[id], let info = Self.resumeInfo(data), let etag = info.etag, HttpPolicy.isStrong(etag),
      record.etag == nil || record.etag == etag, info.bytes > (record.keptBytes ?? 0) else { return false }
    return cloneKept(id, from: info.path ?? osPartial(info.tempName), length: info.bytes, etag: etag)
  }

  /// An APFS clone of `source` cut to `length`: never a full copy, never longer than the source has. Best effort.
  @discardableResult
  private func cloneKept(_ id: String, from source: URL, length: Int64, etag: String) -> Bool {
    guard length > 0, (fileSize(source) ?? 0) >= length else { return false }
    let target = keptFile(id)
    let temp = URL(fileURLWithPath: target.path + ".new")
    try? FileManager.default.removeItem(at: temp)
    guard clonefile(source.path, temp.path, 0) == 0 else { return false }
    do {
      let handle = try FileHandle(forWritingTo: temp)
      defer { try? handle.close() }
      try handle.truncate(atOffset: UInt64(length))
      try handle.synchronize()
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: temp, to: target)
    } catch {
      try? FileManager.default.removeItem(at: temp)
      return false
    }
    guard var record = records[id] else {
      removeKeptFiles(id)
      return false
    }
    record.keptBytes = length
    record.keptEtag = etag
    records[id] = record
    persist()
    return true
  }

  private static func responseKey(_ task: URLSessionTask, _ generation: Int) -> String {
    let http = task.response as? HTTPURLResponse
    return "\(generation) \(http?.statusCode ?? 0) \(http?.value(forHTTPHeaderField: "Content-Range") ?? "") \(http?.value(forHTTPHeaderField: "ETag") ?? "")"
  }

  /// The start of the `bytes=N-` Range on the task's current request (set by the engine or by the OS retrying in the task).
  private static func requestedStart(_ task: URLSessionTask) -> Int64? {
    guard let value = task.currentRequest?.value(forHTTPHeaderField: "Range"), value.hasPrefix("bytes="), value.hasSuffix("-") else { return nil }
    return Int64(value.dropFirst(6).dropLast())
  }

  private func startSnapshotTimer() {
    guard snapshotTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
    timer.setEventHandler { [weak self] in self?.snapshotTick() }
    snapshotTimer = timer
    timer.resume()
  }

  /// A running task's OS file is cloned once a second while it grows and as soon as it stalls for 250 ms: the OS retries
  /// a dropped connection inside the task about a second later and truncates the file to the body of an error answer.
  private func snapshotTick() {
    guard !urlTasks.isEmpty else {
      snapshotTimer?.cancel()
      snapshotTimer = nil
      return
    }
    let now = elapsedMs
    for id in urlTasks.keys where intents[id] == nil {
      guard let reported = taskBytes[id], reported > (records[id]?.keptBytes ?? 0) else { continue }
      let stalled = now - (lastProgress[id] ?? now) >= 250
      guard stalled || now - (lastSnapshot[id] ?? 0) >= 1000, snapshot(id) else { continue }
      if stalled { NSLog("[OfflineDownloads] %@: kept %lld bytes while the transfer stalls", id, reported) }
    }
  }

  /// Clone of the current task's OS file, cut to the reported bytes, while its response is still the validated 2xx one.
  @discardableResult
  private func snapshot(_ id: String) -> Bool {
    guard let ref = urlTasks[id], intents[id] == nil, let record = records[id], record.rangeGeneration != ref.generation,
      record.validatedGeneration == ref.generation, let etag = record.etag, HttpPolicy.isStrong(etag),
      let http = ref.task.response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
      responseKeys[id] == Self.responseKey(ref.task, ref.generation),
      let reported = taskBytes[id], reported > (record.keptBytes ?? 0),
      let source = osFile(id), let size = fileSize(source), size >= reported else { return false }
    if size > reported, !preallocationLogged {
      preallocationLogged = true
      NSLog("[OfflineDownloads] %@: the OS file is %lld bytes ahead of the reported progress; kept bytes follow the reported %lld", id, size - reported, reported)
    }
    guard cloneKept(id, from: source, length: reported, etag: etag) else { return false }
    lastSnapshot[id] = elapsedMs
    return true
  }

  /// The task's OS file only as its own resume data names it; without that exact identity nothing is cloned (N3-01).
  private func osFile(_ id: String) -> URL? { osFiles[id].map(osPartial) }

  /// The OS partial of exactly this name: in the daemon's download directory, or in tmp/ once a pause moved it there.
  private func osPartial(_ name: String) -> URL {
    let running = osDownloadsURL.appendingPathComponent(name)
    let moved = osTempURL.appendingPathComponent(name)
    return !FileManager.default.fileExists(atPath: running.path) && FileManager.default.fileExists(atPath: moved.path) ? moved : running
  }

  /// The OS file is the continuation after the kept bytes: it is appended off the engine queue, then published.
  private func assemble(_ id: String, generation: Int, tail location: URL, size: Int64, pausing: Bool, record: DownloadRecord) {
    let tail = tailFile(id, generation)
    do {
      try? FileManager.default.removeItem(at: tail)
      try FileManager.default.moveItem(at: location, to: tail)
    } catch {
      records[id] = record
      handle(id, Failure(error: DownloadErrorInfo(kind: "file_system", message: "continuation: \(error.localizedDescription)"), retryable: true))
      return
    }
    var updated = record
    updated.bytesWritten = size
    records[id] = updated
    assembling[id] = generation
    let kept = keptFile(id)
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let appended = Self.append(tail, to: kept, expectedSize: size)
      self?.queue.async { self?.finishAssembly(id, generation: generation, appended: appended, pausing: pausing) }
    }
  }

  static func append(_ tail: URL, to kept: URL, expectedSize: Int64) -> Bool {
    do {
      let output = try FileHandle(forWritingTo: kept)
      defer { try? output.close() }
      let input = try FileHandle(forReadingFrom: tail)
      defer { try? input.close() }
      try output.seekToEnd()
      while let chunk = try input.read(upToCount: 8 << 20), !chunk.isEmpty { try output.write(contentsOf: chunk) }
      try output.synchronize()
      return try output.offset() == UInt64(expectedSize)
    } catch {
      return false
    }
  }

  private func finishAssembly(_ id: String, generation: Int, appended: Bool, pausing: Bool) {
    // Only this generation's tail: a cancel, remove or new start meanwhile already dropped the kept bytes (N3-09).
    guard assembling[id] == generation else {
      try? FileManager.default.removeItem(at: tailFile(id, generation))
      return
    }
    try? FileManager.default.removeItem(at: tailFile(id, generation))
    assembling.removeValue(forKey: id)
    defer {
      persist()
      pump()
    }
    guard var record = records[id], record.generation == generation else { return }
    guard appended else {
      records[id] = record
      handle(id, Failure(error: DownloadErrorInfo(kind: "file_system", message: "appending the continuation failed"), retryable: true, dropPartial: true))
      return
    }
    let assembled = keptFile(id)
    record.keptBytes = nil
    record.keptEtag = nil
    record.rangeOffset = nil
    record.rangeGeneration = nil
    record.totalBytes = record.bytesWritten
    if pausing || record.state == DownloadStates.paused {
      do {
        try move(assembled, stagedFile(id))
        record.staged = true
      } catch {
        removeKeptFiles(id)
        record.bytesWritten = 0
      }
      records[id] = record
      return
    }
    guard record.isActive else {
      removeKeptFiles(id)
      records[id] = record
      return
    }
    do {
      try move(assembled, try resolve(record.relativePath, record.volumeId))
    } catch {
      records[id] = record
      let full = (error as NSError).code == NSFileWriteOutOfSpaceError
      handle(id, Failure(error: DownloadErrorInfo(kind: full ? "disk_full" : "file_system", message: error.localizedDescription), retryable: false))
      return
    }
    complete(id, record)
  }
}
#endif
