package android.os

// Host-only shim: the host JVM has every API the module guards by level.
object Build {
  object VERSION {
    const val SDK_INT = 36
  }

  object VERSION_CODES {
    const val O = 26
  }
}
