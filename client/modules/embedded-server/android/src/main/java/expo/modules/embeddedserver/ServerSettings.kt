package expo.modules.embeddedserver

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom

/** Persistent settings (plain preferences) and the generated admin credentials (encrypted preferences). */
class ServerSettings(private val context: Context) {
  private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val secrets: SharedPreferences by lazy { openSecrets() }

  var port: Int
    get() = prefs.getInt(KEY_PORT, DEFAULT_PORT)
    set(value) = prefs.edit().putInt(KEY_PORT, value).apply()

  /** Default: on once the user started the server for the first time. */
  var autostart: Boolean
    get() = prefs.getBoolean(KEY_AUTOSTART, prefs.getBoolean(KEY_STARTED_ONCE, false))
    set(value) = prefs.edit().putBoolean(KEY_AUTOSTART, value).apply()

  fun markStartedOnce() {
    if (!prefs.getBoolean(KEY_STARTED_ONCE, false)) prefs.edit().putBoolean(KEY_STARTED_ONCE, true).apply()
  }

  /** The runtime could not use the system ICU on this box; the server runs with invariant globalization. */
  var invariantGlobalization: Boolean
    get() = prefs.getBoolean(KEY_INVARIANT, false)
    set(value) = prefs.edit().putBoolean(KEY_INVARIANT, value).apply()

  /** The admin password was changed in the web UI, so the generated one is no longer valid. */
  var passwordChanged: Boolean
    get() = prefs.getBoolean(KEY_PASSWORD_CHANGED, false)
    set(value) = prefs.edit().putBoolean(KEY_PASSWORD_CHANGED, value).apply()

  /** A pending password reset: the next server start re-applies the bootstrap password. */
  var resetPending: Boolean
    get() = prefs.getBoolean(KEY_RESET_PENDING, false)
    set(value) = prefs.edit().putBoolean(KEY_RESET_PENDING, value).apply()

  val adminUsername: String get() = ADMIN_USERNAME

  val adminPassword: String
    get() = secrets.getString(KEY_ADMIN_PASSWORD, null) ?: generateSecret(PASSWORD_LENGTH).also {
      secrets.edit().putString(KEY_ADMIN_PASSWORD, it).apply()
    }

  val apiKey: String
    get() = secrets.getString(KEY_API_KEY, null) ?: generateSecret(API_KEY_LENGTH).also {
      secrets.edit().putString(KEY_API_KEY, it).apply()
    }

  fun rotateAdminPassword(): String = generateSecret(PASSWORD_LENGTH).also {
    secrets.edit().putString(KEY_ADMIN_PASSWORD, it).apply()
  }

  private fun openSecrets(): SharedPreferences = try {
    encryptedPreferences()
  } catch (e: Exception) {
    // A key ring lost to a backup/restore or a factory reset leaves undecryptable data: start over with new secrets.
    Log.w(TAG, "Recreating the credential store: ${e.message}")
    context.deleteSharedPreferences(SECRETS)
    encryptedPreferences()
  }

  private fun encryptedPreferences(): SharedPreferences {
    val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    return EncryptedSharedPreferences.create(
      context,
      SECRETS,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  companion object {
    const val DEFAULT_PORT = 8080
    const val ADMIN_USERNAME = "admin"
    private const val TAG = "EmbeddedServer"
    private const val PREFS = "embedded_server"
    private const val SECRETS = "embedded_server_secrets"
    private const val KEY_PORT = "port"
    private const val KEY_AUTOSTART = "autostart"
    private const val KEY_STARTED_ONCE = "started_once"
    private const val KEY_INVARIANT = "invariant_globalization"
    private const val KEY_PASSWORD_CHANGED = "password_changed"
    private const val KEY_RESET_PENDING = "reset_pending"
    private const val KEY_ADMIN_PASSWORD = "admin_password"
    private const val KEY_API_KEY = "api_key"
    private const val PASSWORD_LENGTH = 24
    private const val API_KEY_LENGTH = 40
    // Unambiguous: no 0/O, 1/l/I.
    private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

    fun generateSecret(length: Int): String {
      val random = SecureRandom()
      return buildString(length) { repeat(length) { append(ALPHABET[random.nextInt(ALPHABET.length)]) } }
    }
  }
}
