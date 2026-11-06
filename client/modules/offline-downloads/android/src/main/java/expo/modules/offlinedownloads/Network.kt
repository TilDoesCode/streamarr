package expo.modules.offlinedownloads

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

enum class Net { NONE, METERED, UNMETERED }

/** Default-network watcher: VPNs (Tailscale) count, validation is not required (LAN-only servers). */
class NetworkWatcher(context: Context, private val onChange: () -> Unit) {
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private var registered = false
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = onChange()
    override fun onLost(network: Network) = onChange()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = onChange()
  }

  fun current(): Net {
    val caps = connectivity.activeNetwork?.let { connectivity.getNetworkCapabilities(it) } ?: return Net.NONE
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return Net.NONE
    return if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) Net.UNMETERED else Net.METERED
  }

  fun start() {
    if (registered) return
    registered = runCatching { connectivity.registerDefaultNetworkCallback(callback) }.isSuccess
  }

  fun stop() {
    if (!registered) return
    runCatching { connectivity.unregisterNetworkCallback(callback) }
    registered = false
  }
}
