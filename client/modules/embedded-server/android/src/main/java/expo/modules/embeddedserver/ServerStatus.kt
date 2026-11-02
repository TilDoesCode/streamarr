package expo.modules.embeddedserver

import org.json.JSONArray
import org.json.JSONObject

enum class ServerState(val wire: String) {
  Stopped("stopped"),
  Starting("starting"),
  Running("running"),
  Stopping("stopping"),
  Failed("failed"),
}

data class ServerAddress(val kind: String, val url: String, val interfaceName: String? = null)

data class ServerCredentials(val username: String, val password: String?) {
  fun toMap(): Map<String, Any?> = mapOf("username" to username, "password" to password)

  fun toJson(): JSONObject = JSONObject().put("username", username).put("password", password ?: JSONObject.NULL)
}

/** One snapshot of the embedded server; the JS contract's EmbeddedServerStatus and the OS contract derive from it. */
data class ServerStatus(
  val state: ServerState,
  val port: Int,
  val autostart: Boolean,
  val version: String? = null,
  val startedAt: Long? = null,
  val pid: Int? = null,
  val lastError: String? = null,
  val restartCount: Int = 0,
  val addresses: List<ServerAddress> = emptyList(),
  val dataPath: String,
  val diskFreeBytes: Long? = null,
  val bundleVersion: String,
) {
  // Optional fields are left out instead of null so JS sees `undefined`.
  fun toMap(): Map<String, Any?> = buildMap {
    put("state", state.wire)
    put("port", port)
    put("autostart", autostart)
    version?.let { put("version", it) }
    startedAt?.let { put("startedAt", it.toDouble()) }
    pid?.let { put("pid", it) }
    lastError?.let { put("lastError", it) }
    put("restartCount", restartCount)
    put("addresses", addresses.map { address ->
      buildMap<String, Any> {
        put("kind", address.kind)
        put("url", address.url)
        address.interfaceName?.let { put("interfaceName", it) }
      }
    })
    put("dataPath", dataPath)
    diskFreeBytes?.let { put("diskFreeBytes", it.toDouble()) }
    put("bundleVersion", bundleVersion)
  }

  /** The Streamybox OS ContentProvider contract, version 1: every key present, `startedAt` 0 while not running. */
  fun toContractJson(adminUser: String, adminPasswordAvailable: Boolean, fallbackVersion: String?): JSONObject =
    JSONObject()
      .put("contractVersion", ServerStateProvider.CONTRACT_VERSION)
      .put("state", state.wire)
      .put("port", port)
      .put("autostart", autostart)
      .put("version", version ?: fallbackVersion ?: "")
      .put("startedAt", startedAt ?: 0L)
      .put("lastError", lastError ?: JSONObject.NULL)
      .put("adminUser", adminUser)
      .put("adminPasswordAvailable", adminPasswordAvailable)
      .put("urls", JSONArray().apply { addresses.forEach { put(JSONObject().put("kind", it.kind).put("url", it.url)) } })
}
