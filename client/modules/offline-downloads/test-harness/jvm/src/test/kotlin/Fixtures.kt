package expo.modules.offlinedownloads

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** `http(s)://<name>.fixture/…` answers with a scripted response (by `name/path`, else `name`) and records request headers. */
object Fixtures {
  data class Fixture(
    val code: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
    val input: (() -> InputStream)? = null,
    val length: Long = body.size.toLong(),
  )

  val responses = ConcurrentHashMap<String, Fixture>()
  val requests = ConcurrentHashMap<String, CopyOnWriteArrayList<Map<String, String>>>()

  fun install() {
    Transfer.connect = { url -> if (url.host.endsWith(".fixture")) connection(url) else url.openConnection() }
  }

  fun url(name: String, path: String = "/file", scheme: String = "http") = "$scheme://$name.fixture$path"

  private fun connection(url: URL) = object : HttpURLConnection(url) {
    val name = url.host.removeSuffix(".fixture")
    val fixture get() = responses["$name${url.path}"] ?: responses.getValue(name)
    private var recorded = false
    override fun getResponseCode(): Int {
      if (!recorded) {
        recorded = true
        requests.getOrPut(name) { CopyOnWriteArrayList() }.add(requestProperties.mapValues { it.value.joinToString(",") } + ("path" to url.path))
      }
      return fixture.code
    }
    override fun getHeaderField(name: String) = fixture.headers[name]
    override fun getContentLengthLong() = fixture.length
    override fun getInputStream(): InputStream = fixture.input?.invoke() ?: ByteArrayInputStream(fixture.body)
    override fun connect() {}
    override fun disconnect() {}
    override fun usingProxy() = false
  }

  fun work(name: String): File = File(System.getProperty("harness.work"), name).apply {
    deleteRecursively()
    mkdirs()
  }

  fun partial(range: String, etag: String? = "\"a\"", body: String = "BBBB") =
    Fixture(206, buildMap { put("Content-Range", range); if (etag != null) put("ETag", etag) }, body.toByteArray())
}
