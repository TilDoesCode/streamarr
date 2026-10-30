// Android: ships the app's ART baseline profile (profiles/baseline-prof.txt, scripts/collect-baseline-profile.sh) so installs run AOT-compiled hot paths at once.
const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

const SOURCE = path.join(__dirname, '../profiles/baseline-prof.txt');

/** AGP merges src/main/baseline-prof.txt with the libraries' profiles into assets/dexopt/baseline.prof and the APK's .dm. */
function copyBaselineProfile(platformRoot, source = SOURCE) {
  const target = path.join(platformRoot, 'app/src/main/baseline-prof.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

const withBaselineProfile = (config) =>
  withDangerousMod(config, [
    'android',
    (mod) => {
      copyBaselineProfile(mod.modRequest.platformProjectRoot);
      return mod;
    },
  ]);

module.exports = createRunOncePlugin(
  withBaselineProfile,
  'streamarr-with-baseline-profile',
  '1.0.0'
);
module.exports.copyBaselineProfile = copyBaselineProfile;
module.exports.SOURCE = SOURCE;
