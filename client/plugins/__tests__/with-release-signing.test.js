const { configureRelease, releaseVersion } = require('../with-release-signing');

const generated =
  'android { defaultConfig { versionCode 1\nversionName "0.1.0" }\nbuildTypes { debug { signingConfig signingConfigs.debug } release { signingConfig signingConfigs.debug } } }';

test('release version codes are ordered across patch, minor and major boundaries', () => {
  expect(releaseVersion('v0.16.0')).toEqual({ version: '0.16.0', code: 16000 });
  expect(releaseVersion('1.0.0').code).toBeGreaterThan(releaseVersion('0.999.999').code);
  expect(releaseVersion('0.2.0').code).toBeGreaterThan(releaseVersion('0.1.999').code);
});

test.each(['0.1000.0', '0.1.1000', '9999.0.0', '0.0.0', '1.2.3-beta', '01.2.3', '1.2'])(
  'rejects invalid or colliding version %s',
  (value) => {
    expect(() => releaseVersion(value)).toThrow();
  }
);

test('release signing overrides the generated debug fallback and is idempotent', () => {
  const output = configureRelease(generated, '0.16.0');
  expect(output).toContain('versionCode 16000');
  expect(output).toContain('versionName "0.16.0"');
  expect(output).toContain('debug { signingConfig signingConfigs.debug }');
  expect(output).toContain(
    'android.buildTypes.release.signingConfig = android.signingConfigs.streamarrRelease'
  );
  expect(output).toContain('Debug signing is never used for release.');
  expect(output).toContain('providers.gradleProperty(name)');
  expect(configureRelease(output, '0.16.0')).toBe(output);
});

test('unknown generated Gradle layout fails closed', () => {
  expect(() => configureRelease('android {}', '0.16.0')).toThrow('unsupported');
});
