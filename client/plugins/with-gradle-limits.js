// Caps Gradle memory/parallelism for 8 GB development machines (see docs/client/PLAN.md §3).
const { createRunOncePlugin, withGradleProperties } = require('expo/config-plugins');

const LIMITS = {
  'org.gradle.jvmargs': '-Xmx2g -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
  'org.gradle.workers.max': '4',
};

const withGradleLimits = (config) =>
  withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(LIMITS)) {
      cfg.modResults = cfg.modResults.filter(
        (item) => !(item.type === 'property' && item.key === key)
      );
      cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });

module.exports = createRunOncePlugin(withGradleLimits, 'streamarr-with-gradle-limits', '1.0.0');
