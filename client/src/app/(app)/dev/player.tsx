/* eslint-disable @typescript-eslint/no-require-imports -- a dead __DEV__ branch keeps the screen out of release bundles */
import NotFoundScreen from '../../+not-found';

export default __DEV__
  ? require('@/screens/dev-player/dev-player-screen').DevPlayerScreen
  : NotFoundScreen;
