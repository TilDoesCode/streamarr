const { test, expect } = require('@jest/globals');
const { limits } = require('../with-gradle-limits');

test('keeps the 8 GB development default', () => {
  expect(limits({})['org.gradle.jvmargs']).toBe('-Xmx2g -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8');
  expect(limits({})['org.gradle.workers.max']).toBe('4');
});

test('lets release hosts raise the Gradle heap', () => {
  const jvmargs = '-Xmx6g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8';
  expect(limits({ STREAMARR_GRADLE_JVMARGS: jvmargs })['org.gradle.jvmargs']).toBe(jvmargs);
});
