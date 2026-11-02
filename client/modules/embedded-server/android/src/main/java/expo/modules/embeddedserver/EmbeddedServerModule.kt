package expo.modules.embeddedserver

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS contract of client/modules/embedded-server: every call answers with the full status snapshot. */
class EmbeddedServerModule : Module() {
  private val controller: ServerController by lazy { ServerController.get(appContext.reactContext!!.applicationContext) }
  private val listener: (ServerStatus) -> Unit = { status -> sendEvent(EVENT, status.toMap()) }

  override fun definition() = ModuleDefinition {
    Name("EmbeddedServer")

    Events(EVENT)

    OnStartObserving { controller.addListener(listener) }

    OnStopObserving { controller.removeListener(listener) }

    AsyncFunction("getStatus") { controller.status().toMap() }

    AsyncFunction("start") { controller.start().toMap() }

    AsyncFunction("stop") { controller.stop().toMap() }

    AsyncFunction("setAutostart") { enabled: Boolean -> controller.setAutostart(enabled).toMap() }

    AsyncFunction("setPort") { port: Int -> controller.setPort(port).toMap() }

    AsyncFunction("getCredentials") { controller.credentials().toMap() }

    AsyncFunction("resetAdminPassword") { controller.resetAdminPassword().toMap() }

    AsyncFunction("getLogs") { maxLines: Int -> controller.logs(maxLines) }
  }

  companion object {
    private const val EVENT = "onStatusChange"
  }
}
