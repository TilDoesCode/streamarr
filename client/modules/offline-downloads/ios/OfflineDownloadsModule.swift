import ExpoModulesCore
import Foundation

public class OfflineDownloadsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OfflineDownloads")

    #if os(iOS)
      Events("onProgress", "onState")

      Constant("rootUri") { OfflineDownloadEngine.shared.rootURL.absoluteString }

      OnCreate {
        let engine = OfflineDownloadEngine.shared
        engine.activate()
        engine.addListener(self, (progress: { self.sendEvent("onProgress", $0) }, state: { self.sendEvent("onState", $0) }))
      }

      OnDestroy {
        OfflineDownloadEngine.shared.removeListener(self)
      }

      AsyncFunction("storage") { (volumeId: String?) -> [String: Any] in
        try guarded {
          if let volumeId, volumeId != "internal" { throw EngineError(code: "not_found", detail: "unknown volume \(volumeId)") }
          return try OfflineDownloadEngine.shared.storage()
        }
      }

      AsyncFunction("volumes") { () -> [[String: Any]] in
        let engine = OfflineDownloadEngine.shared
        let storage = (try? engine.storage()) ?? [:]
        return [["id": "internal", "uri": engine.rootURL.absoluteString, "removable": false].merging(storage) { $1 }]
      }

      AsyncFunction("start") { (spec: [String: Any]) -> [String: Any?] in
        try guarded { try OfflineDownloadEngine.shared.start(spec) }
      }
      AsyncFunction("pause") { (id: String) in try guarded { try OfflineDownloadEngine.shared.pause(id) } }
      AsyncFunction("resume") { (id: String, url: String?, headers: [String: String]?) in
        try guarded { try OfflineDownloadEngine.shared.resume(id, url: url, headers: headers) }
      }
      AsyncFunction("cancel") { (id: String) in try guarded { try OfflineDownloadEngine.shared.cancel(id) } }
      AsyncFunction("remove") { (id: String) in try guarded { try OfflineDownloadEngine.shared.remove(id) } }
      AsyncFunction("list") { () -> [[String: Any?]] in OfflineDownloadEngine.shared.list() }
      AsyncFunction("get") { (id: String) -> [String: Any?]? in OfflineDownloadEngine.shared.get(id) }

      AsyncFunction("getSettings") { () -> [String: Any] in
        let settings = OfflineDownloadEngine.shared.currentSettings()
        return ["wifiOnly": settings.wifiOnly, "maxConcurrent": settings.maxConcurrent]
      }
      AsyncFunction("setWifiOnly") { (wifiOnly: Bool) in OfflineDownloadEngine.shared.setWifiOnly(wifiOnly) }
      AsyncFunction("setMaxConcurrent") { (value: Int) in OfflineDownloadEngine.shared.setMaxConcurrent(value) }

      // Background URLSession needs no notification permission.
      AsyncFunction("getNotificationPermission") { () -> String in "granted" }
      AsyncFunction("requestNotificationPermission") { () -> String in "granted" }

      Function("uriFor") { (relativePath: String, volumeId: String?) -> String in
        try guarded { try OfflineDownloadEngine.shared.resolve(relativePath, volumeId).absoluteString }
      }
      AsyncFunction("contentUriFor") { (_: String, _: String?, _: String?) -> String? in nil }

      AsyncFunction("exists") { (relativePath: String, volumeId: String?) -> Bool in
        try guarded { FileManager.default.fileExists(atPath: try OfflineDownloadEngine.shared.resolve(relativePath, volumeId).path) }
      }
      AsyncFunction("fileSize") { (relativePath: String, volumeId: String?) -> Double? in
        try guarded {
          let url = try OfflineDownloadEngine.shared.resolve(relativePath, volumeId)
          var isDirectory: ObjCBool = false
          guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else { return nil }
          return ((try FileManager.default.attributesOfItem(atPath: url.path))[.size] as? NSNumber)?.doubleValue
        }
      }
      AsyncFunction("deletePath") { (relativePath: String, volumeId: String?) in
        try guarded { try OfflineDownloadEngine.shared.deletePath(relativePath, volumeId) }
      }
      AsyncFunction("move") { (from: String, to: String, volumeId: String?) in
        try guarded { try OfflineDownloadEngine.shared.movePath(from, to, volumeId) }
      }
      AsyncFunction("sha256") { (relativePath: String, volumeId: String?) -> String in
        try guarded { try FileHash.sha256(try OfflineDownloadEngine.shared.resolve(relativePath, volumeId)) }
      }
      // Diagnostics for tests (DL-Q): whether a file or directory is excluded from iCloud/iTunes backup.
      AsyncFunction("isExcludedFromBackup") { (relativePath: String?) -> Bool in
        let engine = OfflineDownloadEngine.shared
        let url = try relativePath.map { try engine.resolve($0, nil) } ?? engine.rootURL
        return engine.isExcludedFromBackup(url)
      }
    #endif
  }
}

#if os(iOS)
  /// Engine errors reach JS with their code (`error.code`) and the code as the message prefix.
  private func guarded<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch let error as EngineError {
      throw Exception(name: "OfflineDownloadsError", description: error.message, code: error.code)
    } catch let error as Exception {
      throw error
    } catch {
      throw Exception(name: "OfflineDownloadsError", description: "io: \(error.localizedDescription)", code: "io")
    }
  }
#endif
