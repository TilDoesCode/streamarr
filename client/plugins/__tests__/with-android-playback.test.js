const { describe, expect, it } = require('@jest/globals');
const { applyPlaybackManifest } = require('../with-android-playback');

const manifest = () => ({
  manifest: {
    application: [
      {
        $: { 'android:name': '.MainApplication' },
        activity: [
          {
            $: {
              'android:name': '.MainActivity',
              'android:configChanges': 'keyboard|orientation|screenSize|uiMode',
            },
            'intent-filter': [
              {
                action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
              },
            ],
          },
        ],
      },
    ],
  },
});

describe('with-android-playback', () => {
  it('keeps the activity across HDR/refresh switches and gives ExoPlayer the large heap', () => {
    const out = applyPlaybackManifest(manifest());
    const application = out.manifest.application[0];
    expect(application.$['android:largeHeap']).toBe('true');
    expect(application.activity[0].$['android:configChanges']).toBe(
      'keyboard|orientation|screenSize|uiMode|colorMode|density'
    );
  });

  it('is idempotent', () => {
    const once = applyPlaybackManifest(manifest());
    const twice = applyPlaybackManifest(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});
