import { waitFor } from 'expo-router/testing-library';

import {
  fakeOfflineDownload,
  installTestDownloads,
  seedDownloads,
  WORLD_OWNER,
} from '../../../jest/downloads';
import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import { resolveLocalPlayTarget } from '../local-play';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

it('C1-21: the profile age rules from /viewer/me are kept on the device and lock downloads above them', async () => {
  const test = installTestDownloads();
  seedDownloads(test, [
    fakeOfflineDownload({
      id: 'm16',
      accountKey: WORLD_OWNER,
      workId: 'tmdb-movie-603',
      meta: { title: 'Sixteen', minimumAge: 16, rated: true },
    }),
  ]);
  world.handlers['/api/v1/viewer/me'] = () =>
    json(200, {
      id: 'v-anna',
      username: 'anna',
      displayName: 'Anna',
      permissions: { maxAge: 12, blockUnrated: true, allowDownloads: true },
    });
  await open('/');
  await waitFor(() => expect(test.store.policy(WORLD_OWNER)).toMatchObject({ maxAge: 12 }), WAIT);
  const manager = (
    globalThis as { __streamarrDownloadManager?: Parameters<typeof resolveLocalPlayTarget>[2] }
  ).__streamarrDownloadManager!;
  expect(resolveLocalPlayTarget('tmdb-movie-603', WORLD_OWNER, manager, test.engine)).toBeNull();
  expect(test.store.get('m16')!.state).toBe('done');
});
