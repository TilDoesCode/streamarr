package expo.modules.embeddedserver

import java.net.Inet4Address
import java.net.NetworkInterface

/** Reachable base URLs of the server, kinds exactly as the OS contract: LAN first, Tailscale, loopback last. */
object Addresses {
  private val order = listOf("lan", "tailscale", "loopback")

  fun enumerate(port: Int): List<ServerAddress> {
    val found = mutableListOf<ServerAddress>()
    val interfaces = try {
      NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    } catch (_: Exception) {
      emptyList()
    }
    for (nic in interfaces) {
      if (!runCatching { nic.isUp && !nic.isLoopback }.getOrDefault(false)) continue
      for (address in nic.inetAddresses) {
        if (address !is Inet4Address || address.isLoopbackAddress || address.isLinkLocalAddress) continue
        val host = address.hostAddress ?: continue
        found += ServerAddress(kindOf(nic.name, address), "http://$host:$port", nic.name)
      }
    }
    found += ServerAddress("loopback", "http://127.0.0.1:$port")
    return found.sortedBy { order.indexOf(it.kind) }
  }

  // Tailscale hands out 100.64.0.0/10 (CGNAT) addresses on its VPN interface; every other address counts as LAN.
  internal fun kindOf(name: String, address: Inet4Address): String {
    val bytes = address.address
    val cgnat = (bytes[0].toInt() and 0xff) == 100 && (bytes[1].toInt() and 0xff) in 64..127
    return if (cgnat || name.startsWith("tailscale")) "tailscale" else "lan"
  }
}
