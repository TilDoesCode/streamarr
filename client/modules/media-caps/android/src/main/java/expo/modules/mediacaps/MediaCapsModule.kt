package expo.modules.mediacaps

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaCapsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MediaCaps")

    AsyncFunction("getCapabilitiesAsync") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AndroidCaps.report(context)
    }

    AsyncFunction("readCodecLogAsync") { sinceEpochMs: Double ->
      CodecLog.read(sinceEpochMs.toLong())
    }
  }
}
