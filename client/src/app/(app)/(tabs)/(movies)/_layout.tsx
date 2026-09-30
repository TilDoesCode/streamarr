import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'movies' };

export default function MoviesTabLayout() {
  return <TabStack tab="movies" />;
}
