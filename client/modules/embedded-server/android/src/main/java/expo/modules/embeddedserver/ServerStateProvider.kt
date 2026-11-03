package expo.modules.embeddedserver

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle

/**
 * Control surface for the Streamybox OS Settings app (contract version 1): `content://dev.streamarr.app.server/state`
 * is one row with a `json` column, and `call()` carries the commands. Guarded by the SERVER_CONTROL permission.
 */
class ServerStateProvider : ContentProvider() {
  private val controller: ServerController get() = ServerController.get(context!!)

  override fun onCreate(): Boolean = true

  override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? {
    enforcePermission()
    if (uri.lastPathSegment != PATH_STATE) return null
    return MatrixCursor(arrayOf(COLUMN_JSON)).apply {
      addRow(arrayOf(controller.contractJson().toString()))
      setNotificationUri(context!!.contentResolver, STATE_URI)
    }
  }

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    enforcePermission()
    return try {
      val json = when (method) {
        "status" -> controller.contractJson()
        "start" -> { controller.start(); controller.contractJson() }
        "stop" -> { controller.stop(); controller.contractJson() }
        "autostart" -> { controller.setAutostart(arg?.toBooleanStrictOrNull() ?: throw IllegalArgumentException("arg must be \"true\" or \"false\"")); controller.contractJson() }
        "credentials" -> controller.credentials().toJson()
        "resetAdminPassword" -> controller.resetAdminPassword().toJson()
        "open" -> { openLocalServerScreen(); controller.contractJson() }
        else -> return Bundle().apply { putBoolean(KEY_OK, false); putString(KEY_JSON, "{}"); putString(KEY_ERROR, "Unknown method") }
      }
      Bundle().apply { putBoolean(KEY_OK, true); putString(KEY_JSON, json.toString()) }
    } catch (e: Exception) {
      Bundle().apply { putBoolean(KEY_OK, false); putString(KEY_JSON, "{}"); putString(KEY_ERROR, e.message ?: e.toString()) }
    }
  }

  // The framework enforces android:permission for query/insert/update/delete; call() needs the explicit check.
  private fun enforcePermission() = context!!.enforceCallingOrSelfPermission(PERMISSION, "$PERMISSION is required")

  private fun openLocalServerScreen() {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(LOCAL_SERVER_LINK)).setPackage(context!!.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context!!.startActivity(intent)
  }

  override fun getType(uri: Uri): String = "application/json"

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int = 0

  companion object {
    const val CONTRACT_VERSION = 1
    const val AUTHORITY = "dev.streamarr.app.server"
    const val PERMISSION = "dev.streamarr.permission.SERVER_CONTROL"
    const val LOCAL_SERVER_LINK = "streamarr://server/local"
    private const val PATH_STATE = "state"
    private const val COLUMN_JSON = "json"
    private const val KEY_OK = "ok"
    private const val KEY_JSON = "json"
    private const val KEY_ERROR = "error"
    val STATE_URI: Uri = Uri.parse("content://$AUTHORITY/$PATH_STATE")
  }
}
