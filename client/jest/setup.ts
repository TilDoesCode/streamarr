import 'react-native-gesture-handler/jestSetup';

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock');
  // The stock mock's makeMutable returns the raw value; its useSharedValue builds a real get/set box.
  return { ...mock, useReducedMotion: () => false, makeMutable: mock.useSharedValue };
});
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default
);
// react-native-mmkv switches to its in-memory mock under Jest but still imports Nitro at load time.
jest.mock('react-native-nitro-modules', () => ({ NitroModules: {} }));
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js')
);
jest.mock('@modules/media-caps/src/MediaCapsModule', () => ({
  getCapabilitiesAsync: () => Promise.reject(new Error('media-caps is native only')),
  readCodecLogAsync: () => Promise.resolve([]),
}));
