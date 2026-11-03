package expo.modules.embeddedserver

import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The Streamybox OS contract (version 1) exercised from another package that holds SERVER_CONTROL. */
@RunWith(AndroidJUnit4::class)
class ServerContractTest {
  private val context = InstrumentationRegistry.getInstrumentation().context
  private val uri: Uri = Uri.parse("content://dev.streamarr.app.server/state")
  private val states = setOf("stopped", "starting", "running", "stopping", "failed")

  private fun call(method: String, arg: String? = null): JSONObject {
    val result = context.contentResolver.call(uri, method, arg, null)!!
    assertTrue("$method failed: ${result.getString("error")}", result.getBoolean("ok"))
    return JSONObject(result.getString("json")!!)
  }

  private fun queryState(): JSONObject = context.contentResolver.query(uri, arrayOf("json"), null, null, null)!!.use { cursor ->
    assertTrue(cursor.moveToFirst())
    JSONObject(cursor.getString(cursor.getColumnIndexOrThrow("json")))
  }

  private fun assertShape(state: JSONObject) {
    for (key in listOf("contractVersion", "state", "port", "autostart", "version", "startedAt", "lastError", "adminUser", "adminPasswordAvailable", "urls"))
      assertTrue("missing $key in $state", state.has(key))
    assertEquals(1, state.getInt("contractVersion"))
    assertTrue(state.getString("state") in states)
    assertEquals("admin", state.getString("adminUser"))
    val urls = state.getJSONArray("urls")
    for (i in 0 until urls.length()) assertTrue(urls.getJSONObject(i).getString("kind") in setOf("lan", "tailscale", "loopback"))
  }

  @Test
  fun providerIsResolvableAndGuarded() {
    assertEquals("dev.streamarr.app", context.packageManager.resolveContentProvider("dev.streamarr.app.server", 0)?.packageName)
    val unknown = context.contentResolver.call(uri, "nope", null, null)!!
    assertFalse(unknown.getBoolean("ok"))
    assertEquals("{}", unknown.getString("json"))
    assertEquals("Unknown method", unknown.getString("error"))
    assertFalse(context.contentResolver.call(uri, "autostart", "maybe", null)!!.getBoolean("ok"))
  }

  @Test
  fun startsAndReportsTheRunningServer() {
    assertShape(queryState())
    assertShape(call("status"))
    val credentials = call("credentials")
    assertEquals("admin", credentials.getString("username"))
    assertTrue(credentials.getString("password").length >= 20)
    assertEquals(true, call("autostart", "true").getBoolean("autostart"))

    val started = call("start")
    assertTrue(started.getString("state") in setOf("starting", "running"))
    val deadline = SystemClock.elapsedRealtime() + 240_000
    var state = queryState()
    while (state.getString("state") != "running" && SystemClock.elapsedRealtime() < deadline) {
      assertTrue("server failed: ${state.optString("lastError")}", state.getString("state") != "failed")
      SystemClock.sleep(1_000)
      state = queryState()
    }
    Log.i(TAG, "state: $state")
    assertShape(state)
    assertEquals("running", state.getString("state"))
    assertTrue(state.getLong("startedAt") > 0)
    assertTrue(state.getString("version").isNotEmpty())
    assertTrue(state.getBoolean("adminPasswordAvailable"))
    val kinds = (0 until state.getJSONArray("urls").length()).map { state.getJSONArray("urls").getJSONObject(it).getString("kind") }
    assertTrue(kinds.toString(), "loopback" in kinds)
    assertNotNull(state.get("port"))
  }

  /** The restart behind a password reset: while the state is not `running`, `startedAt` is 0 and `urls` is empty. */
  @Test
  fun startedAtAndUrlsBelongToTheRunningProcessOnly() {
    call("start")
    var state = awaitRunning()
    val before = state.getLong("startedAt")
    assertTrue(before > 0)
    call("resetAdminPassword")
    var sawRestart = false
    val deadline = SystemClock.elapsedRealtime() + 240_000
    while (SystemClock.elapsedRealtime() < deadline) {
      state = queryState()
      if (state.getString("state") != "running") {
        if (!sawRestart) Log.i(TAG, "during reset: $state")
        sawRestart = true
        assertEquals(state.toString(), 0L, state.getLong("startedAt"))
        assertEquals(state.toString(), 0, state.getJSONArray("urls").length())
      } else if (sawRestart) break
      SystemClock.sleep(50)
    }
    assertTrue("the reset never left running", sawRestart)
    Log.i(TAG, "after reset: $state")
    assertEquals("running", state.getString("state"))
    assertTrue(state.getLong("startedAt") > before)
    assertTrue(state.getJSONArray("urls").length() > 0)
    val stopped = call("stop")
    assertEquals("stopped", stopped.getString("state"))
    assertEquals(0L, stopped.getLong("startedAt"))
    assertEquals(0, stopped.getJSONArray("urls").length())
  }

  private fun awaitRunning(): JSONObject {
    val deadline = SystemClock.elapsedRealtime() + 240_000
    var state = queryState()
    while (state.getString("state") != "running" && SystemClock.elapsedRealtime() < deadline) {
      assertTrue("server failed: ${state.optString("lastError")}", state.getString("state") != "failed")
      SystemClock.sleep(500)
      state = queryState()
    }
    return state
  }

  companion object {
    private const val TAG = "ServerContractTest"
  }
}
