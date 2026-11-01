import {
  needsNativeUpdate,
  parseAndroidRelease,
  parseIosSource,
  type NativeRelease,
} from '../native-release';

const source = {
  apps: [
    {
      bundleIdentifier: 'other.app',
      versions: [{ version: '9.0.0', buildVersion: '99', downloadURL: 'x' }],
    },
    {
      bundleIdentifier: 'dev.streamarr.app',
      versions: [
        {
          version: '0.21.0',
          buildVersion: '7',
          runtimeVersion: 'rt-new',
          downloadURL: 'https://example.test/7.ipa',
          date: '2026-11-02T10:00:00Z',
          localizedDescription: 'Notes',
        },
        {
          version: '0.1.0',
          buildVersion: '4',
          runtimeVersion: 'rt-old',
          downloadURL: 'https://example.test/4.ipa',
        },
        { version: 'broken', buildVersion: 'x', downloadURL: 'https://example.test/x.ipa' },
      ],
    },
  ],
};

const release = (build: number, runtimeVersion: string | null): NativeRelease => ({
  version: '1.0.0',
  build,
  runtimeVersion,
  downloadURL: 'https://example.test/app',
  date: null,
  notes: null,
});

describe('parseIosSource', () => {
  it('picks the highest build of this app and skips malformed versions', () => {
    expect(parseIosSource(source, 'dev.streamarr.app')).toEqual({
      version: '0.21.0',
      build: 7,
      runtimeVersion: 'rt-new',
      downloadURL: 'https://example.test/7.ipa',
      date: '2026-11-02T10:00:00Z',
      notes: 'Notes',
    });
  });

  it('returns null for an unknown app or an unexpected document', () => {
    expect(parseIosSource(source, 'missing.app')).toBeNull();
    expect(parseIosSource({ nope: true }, 'dev.streamarr.app')).toBeNull();
    expect(parseIosSource(null, 'dev.streamarr.app')).toBeNull();
  });
});

describe('parseAndroidRelease', () => {
  it('reads the version code as build', () => {
    expect(
      parseAndroidRelease({
        version: '0.21.0',
        versionCode: 21000,
        runtimeVersion: 'rt',
        downloadURL: 'https://example.test/a.apk',
      })
    ).toMatchObject({ version: '0.21.0', build: 21000, runtimeVersion: 'rt' });
    expect(parseAndroidRelease({ version: '0.21.0', downloadURL: 'x' })).toBeNull();
  });
});

describe('needsNativeUpdate', () => {
  const installed = { build: 4, runtimeVersion: 'rt-old' };

  it('requires a reinstall when a newer build ships another runtime', () => {
    expect(needsNativeUpdate(installed, release(7, 'rt-new'))).toBe(true);
  });

  it('leaves a newer build on the same runtime to the OTA update', () => {
    expect(needsNativeUpdate(installed, release(7, 'rt-old'))).toBe(false);
  });

  it('treats a newer build without a recorded runtime as native', () => {
    expect(needsNativeUpdate(installed, release(7, null))).toBe(true);
  });

  it('ignores the installed build, older builds and unknown installs', () => {
    expect(needsNativeUpdate(installed, release(4, 'rt-new'))).toBe(false);
    expect(needsNativeUpdate(installed, release(3, 'rt-new'))).toBe(false);
    expect(needsNativeUpdate({ build: null, runtimeVersion: null }, release(7, 'rt-new'))).toBe(
      false
    );
    expect(needsNativeUpdate(installed, null)).toBe(false);
  });
});
