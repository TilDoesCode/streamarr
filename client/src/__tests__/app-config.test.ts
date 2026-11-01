import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig from '../../app.config';

const config = appConfig({ config: {} } as ConfigContext) as ExpoConfig;

describe('app config', () => {
  it('lets iOS reach self-hosted servers over plain HTTP by name (LAN, Tailscale)', () => {
    const ats = config.ios?.infoPlist?.NSAppTransportSecurity as Record<string, unknown>;
    expect(ats.NSAllowsArbitraryLoads).toBe(true);
    // Any of these makes iOS ignore NSAllowsArbitraryLoads.
    for (const key of [
      'NSAllowsLocalNetworking',
      'NSAllowsArbitraryLoadsForMedia',
      'NSAllowsArbitraryLoadsInWebContent',
    ]) {
      expect(ats).not.toHaveProperty(key);
    }
  });
});
