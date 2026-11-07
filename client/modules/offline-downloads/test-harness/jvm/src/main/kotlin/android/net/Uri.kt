package android.net

import java.io.File

// Host-only shim: the module sources are compiled unchanged.
class Uri(private val value: String) {
  override fun toString() = value

  companion object {
    fun fromFile(file: File) = Uri(file.toURI().toString())
  }
}
