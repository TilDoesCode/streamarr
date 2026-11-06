package expo.modules.offlinedownloads

import org.json.JSONArray
import org.json.JSONObject

object States {
  const val QUEUED = "queued"
  const val RUNNING = "running"
  const val PAUSED = "paused"
  const val WAITING_NETWORK = "waiting_network"
  const val WAITING_WIFI = "waiting_wifi"
  const val RETRYING = "retrying"
  const val COMPLETED = "completed"
  const val FAILED = "failed"
  const val CANCELLED = "cancelled"

  /** States the engine keeps working on by itself. */
  val ACTIVE = setOf(QUEUED, RUNNING, WAITING_NETWORK, WAITING_WIFI, RETRYING)
}

data class DownloadError(val kind: String, val message: String, val httpStatus: Int? = null, val retryAfterMs: Long? = null) {
  fun toJson(): JSONObject = JSONObject().put("kind", kind).put("message", message).apply {
    httpStatus?.let { put("httpStatus", it) }
    retryAfterMs?.let { put("retryAfterMs", it) }
  }

  /** Absent fields are left out (the JS type has them optional, not nullable). */
  fun toMap(): Map<String, Any?> =
    mapOf("kind" to kind, "message" to message, "httpStatus" to httpStatus, "retryAfterMs" to retryAfterMs?.toDouble()).filterValues { it != null }

  companion object {
    fun fromJson(json: JSONObject?): DownloadError? = json?.let {
      DownloadError(
        it.optString("kind", "unknown"),
        it.optString("message"),
        if (it.has("httpStatus")) it.getInt("httpStatus") else null,
        if (it.has("retryAfterMs")) it.getLong("retryAfterMs") else null,
      )
    }
  }
}

class TaskRecord(
  val id: String,
  var url: String,
  var headers: Map<String, String>,
  val relativePath: String,
  val volumeId: String,
  val expectedBytes: Long?,
  val expectedEtag: String?,
  val title: String?,
  var state: String,
  var bytesWritten: Long = 0,
  var totalBytes: Long? = null,
  var etag: String? = null,
  var lastModified: String? = null,
  var restarts: Int = 0,
  var attempts: Int = 0,
  var retryAt: Long? = null,
  var error: DownloadError? = null,
  val createdAt: Long = System.currentTimeMillis(),
  var updatedAt: Long = createdAt,
) {
  val isActive get() = state in States.ACTIVE

  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("url", url)
    put("headers", JSONObject(headers))
    put("relativePath", relativePath)
    put("volumeId", volumeId)
    expectedBytes?.let { put("expectedBytes", it) }
    expectedEtag?.let { put("expectedEtag", it) }
    title?.let { put("title", it) }
    put("state", state)
    put("bytesWritten", bytesWritten)
    totalBytes?.let { put("totalBytes", it) }
    etag?.let { put("etag", it) }
    lastModified?.let { put("lastModified", it) }
    put("restarts", restarts)
    put("attempts", attempts)
    retryAt?.let { put("retryAt", it) }
    error?.let { put("error", it.toJson()) }
    put("createdAt", createdAt)
    put("updatedAt", updatedAt)
  }

  fun toMap(uri: String): Map<String, Any?> = mapOf(
    "id" to id,
    "url" to url,
    "relativePath" to relativePath,
    "volumeId" to volumeId,
    "uri" to uri,
    "state" to state,
    "bytesWritten" to bytesWritten.toDouble(),
    "totalBytes" to totalBytes?.toDouble(),
    "etag" to etag,
    "restarts" to restarts,
    "attempts" to attempts,
    "retryAt" to retryAt?.toDouble(),
    "error" to error?.toMap(),
    "createdAt" to createdAt.toDouble(),
    "updatedAt" to updatedAt.toDouble(),
  )

  companion object {
    fun fromJson(json: JSONObject): TaskRecord {
      val headers = json.optJSONObject("headers")?.let { h -> h.keys().asSequence().associateWith { h.getString(it) } } ?: emptyMap()
      return TaskRecord(
        id = json.getString("id"),
        url = json.getString("url"),
        headers = headers,
        relativePath = json.getString("relativePath"),
        volumeId = json.optString("volumeId", Volumes.INTERNAL),
        expectedBytes = json.optLongOrNull("expectedBytes"),
        expectedEtag = json.optStringOrNull("expectedEtag"),
        title = json.optStringOrNull("title"),
        state = json.getString("state"),
        bytesWritten = json.optLong("bytesWritten", 0),
        totalBytes = json.optLongOrNull("totalBytes"),
        etag = json.optStringOrNull("etag"),
        lastModified = json.optStringOrNull("lastModified"),
        restarts = json.optInt("restarts", 0),
        attempts = json.optInt("attempts", 0),
        retryAt = json.optLongOrNull("retryAt"),
        error = DownloadError.fromJson(json.optJSONObject("error")),
        createdAt = json.optLong("createdAt", System.currentTimeMillis()),
        updatedAt = json.optLong("updatedAt", System.currentTimeMillis()),
      )
    }
  }
}

data class Settings(val wifiOnly: Boolean = true, val maxConcurrent: Int = 2) {
  fun toJson(): JSONObject = JSONObject().put("wifiOnly", wifiOnly).put("maxConcurrent", maxConcurrent)

  companion object {
    fun fromJson(json: JSONObject?): Settings =
      if (json == null) Settings() else Settings(json.optBoolean("wifiOnly", true), json.optInt("maxConcurrent", 2).coerceIn(1, 6))
  }
}

fun tasksToJson(tasks: Collection<TaskRecord>): JSONArray = JSONArray().apply { tasks.forEach { put(it.toJson()) } }

private fun JSONObject.optLongOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null

private fun JSONObject.optStringOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
