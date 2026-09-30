import AppLayout from '@/app/(app)/_layout';
import MovieRoute from '@/app/(app)/(tabs)/(home,search)/movie/[id]';
import SeriesRoute from '@/app/(app)/(tabs)/(home,search)/series/[id]/index';
import SeasonRoute from '@/app/(app)/(tabs)/(home,search)/series/[id]/season/[n]';
import HomeLayout, { unstable_settings as homeSettings } from '@/app/(app)/(tabs)/(home)/_layout';
import HomeRoute from '@/app/(app)/(tabs)/(home)/index';
import SearchLayout, {
  unstable_settings as searchSettings,
} from '@/app/(app)/(tabs)/(search)/_layout';
import SearchRoute from '@/app/(app)/(tabs)/(search)/search';
import SettingsLayout, {
  unstable_settings as settingsSettings,
} from '@/app/(app)/(tabs)/(settings)/_layout';
import SettingsRoute from '@/app/(app)/(tabs)/(settings)/settings';
import ChangePasswordRoute from '@/app/(onboarding)/sign-in/change-password';
import SignInRoute from '@/app/(onboarding)/sign-in/index';
import SecondFactorRoute from '@/app/(onboarding)/sign-in/second-factor';
import ProfilesRoute from '@/app/(onboarding)/profiles';
import VersionsRoute from '@/app/(app)/versions/[workId]';
import ServerRoute from '@/app/(onboarding)/server';
import { LargeShell } from '@/navigation/large-shell';

// Unit tests render the headless large-screen shell (the jest window is tablet-sized): NativeTabs needs the native tab host.
export const appRoutes = {
  '(app)/_layout': AppLayout,
  '(app)/(tabs)/_layout': LargeShell,
  '(app)/(tabs)/(home)/_layout': { default: HomeLayout, unstable_settings: homeSettings },
  '(app)/(tabs)/(home)/index': HomeRoute,
  '(app)/(tabs)/(search)/_layout': { default: SearchLayout, unstable_settings: searchSettings },
  '(app)/(tabs)/(search)/search': SearchRoute,
  '(app)/(tabs)/(settings)/_layout': {
    default: SettingsLayout,
    unstable_settings: settingsSettings,
  },
  '(app)/(tabs)/(settings)/settings': SettingsRoute,
  '(app)/(tabs)/(home,search)/movie/[id]': MovieRoute,
  '(app)/(tabs)/(home,search)/series/[id]/index': SeriesRoute,
  '(app)/(tabs)/(home,search)/series/[id]/season/[n]': SeasonRoute,
  // The player needs native video modules; tests check the route and its params.
  '(app)/play/[playbackId]': () => null,
  // The player lab needs native video modules; tests only need the route to exist.
  '(app)/dev/player': () => null,
  '(app)/versions/[workId]': VersionsRoute,
  '(onboarding)/server': ServerRoute,
  '(onboarding)/profiles': ProfilesRoute,
  '(onboarding)/sign-in/index': SignInRoute,
  '(onboarding)/sign-in/second-factor': SecondFactorRoute,
  '(onboarding)/sign-in/change-password': ChangePasswordRoute,
};
