const fs = require('fs');
const path = require('path');
const { describe, expect, it } = require('@jest/globals');
const { INSTRUMENTATION, MARKER, TARGET_CLASS } = require('../with-a11y-service-cache');

// The prebuilt react-android AAR is built from this source; the AGP instrumentation fails the build if the call disappears.
const source = path.join(
  __dirname,
  '../../node_modules/react-native/ReactAndroid/src/main/java',
  `${TARGET_CLASS.replace(/\./g, '/')}.kt`
);

describe('with-a11y-service-cache', () => {
  it('targets the class that still queries the enabled services after every view update', () => {
    const kotlin = fs.readFileSync(source, 'utf8');
    expect(kotlin).toMatch(/onAfterUpdateTransaction[\s\S]*manageFocusGuideAccessibilityDelegate/);
    expect(kotlin).toContain('getEnabledAccessibilityServiceList(');
  });

  it('routes only that call and fails the build when it is gone', () => {
    const gradle = INSTRUMENTATION(TARGET_CLASS);
    expect(gradle).toContain(MARKER);
    expect(gradle).toContain(`classData.className == '${TARGET_CLASS}'`);
    expect(gradle).toContain("'expo/modules/hostsystem/A11yServiceCache', 'enabledList'");
    expect(gradle).toMatch(/if \(!routed\) throw new GradleException/);
  });
});
