const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, expect, it } = require('@jest/globals');
const { copyBaselineProfile, SOURCE } = require('../with-baseline-profile');

describe('with-baseline-profile', () => {
  it('ships a profile with the TV hot paths (Fabric mounting, views, Reanimated, images)', () => {
    const profile = fs.readFileSync(SOURCE, 'utf8');
    for (const cls of [
      'Lcom/facebook/react/fabric/FabricUIManager;',
      'Lcom/facebook/react/views/view/ReactViewManager;',
      'Lcom/facebook/react/views/scroll/ReactHorizontalScrollView;',
      'Lcom/swmansion/reanimated/NodesManager;',
      'Lexpo/modules/image/ExpoImageView;',
    ])
      expect(profile).toContain(cls);
    // Only class and method rules (no comments or blank lines that AGP would reject).
    for (const line of profile.split('\n').filter(Boolean)) expect(line).toMatch(/^[HSP]*L[^;]+;/);
  });

  it('copies it to the app module, where AGP merges it into baseline.prof and the .dm', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
    const target = copyBaselineProfile(root);
    expect(target).toBe(path.join(root, 'app/src/main/baseline-prof.txt'));
    expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(SOURCE, 'utf8'));
  });
});
