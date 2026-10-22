// Android playback hardening for 4K/HDR on TV boxes (docs/client/journal: ROCK 4D 4K crash).
const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// An HDR/refresh switch of the HDMI output changes colorMode (and may change density): never recreate the player's activity.
const EXTRA_CONFIG_CHANGES = ['colorMode', 'density'];

/** Adds the playback config changes to MainActivity and the large Java heap to the application (ExoPlayer buffers live there). */
function applyPlaybackManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:largeHeap'] = 'true';
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const current = (activity.$['android:configChanges'] ?? '').split('|').filter(Boolean);
  for (const change of EXTRA_CONFIG_CHANGES) if (!current.includes(change)) current.push(change);
  activity.$['android:configChanges'] = current.join('|');
  return manifest;
}

const withAndroidPlayback = (config) =>
  withAndroidManifest(config, (mod) => {
    mod.modResults = applyPlaybackManifest(mod.modResults);
    return mod;
  });

module.exports = createRunOncePlugin(
  withAndroidPlayback,
  'streamarr-with-android-playback',
  '1.0.0'
);
module.exports.applyPlaybackManifest = applyPlaybackManifest;
