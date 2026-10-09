// Caps Gradle memory/parallelism for 8 GB development machines (see docs/client/PLAN.md §3).
const { createRunOncePlugin, withGradleProperties } = require('expo/config-plugins');

// STREAMARR_GRADLE_JVMARGS overrides the heap for larger hosts (the release APK needs more than 2 GB to package).
const limits = (env = process.env) => ({
  'org.gradle.jvmargs': env.STREAMARR_GRADLE_JVMARGS || '-Xmx2g -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
  'org.gradle.workers.max': '4',
});

const withGradleLimits = (config) =>
  withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(limits())) {
      cfg.modResults = cfg.modResults.filter(
        (item) => !(item.type === 'property' && item.key === key)
      );
      cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });

module.exports = createRunOncePlugin(withGradleLimits, 'streamarr-with-gradle-limits', '1.0.0');
module.exports.limits = limits;
