package expo.modules.embeddedserver

import expo.modules.kotlin.exception.CodedException

/** Rejections of the JS contract: a stable code (`error.code`) and a message prefixed with it. */
class ServerException(code: String, detail: String, cause: Throwable? = null) : CodedException(code, "$code: $detail", cause) {
  companion object {
    const val PORT_IN_USE = "port_in_use"
    const val BUNDLE_MISSING = "bundle_missing"
    const val SERVICE_UNAVAILABLE = "service_unavailable"
    const val START_FAILED = "start_failed"
    const val STOP_FAILED = "stop_failed"
    const val NOT_SUPPORTED = "not_supported"
  }
}
