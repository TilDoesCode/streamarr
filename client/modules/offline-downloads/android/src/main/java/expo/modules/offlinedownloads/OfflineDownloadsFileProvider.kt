package expo.modules.offlinedownloads

import androidx.core.content.FileProvider

/** Own subclass so the authority never collides with another FileProvider in the app. */
class OfflineDownloadsFileProvider : FileProvider()
