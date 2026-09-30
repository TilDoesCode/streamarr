import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'series' };

export default function SeriesTabLayout() {
  return <TabStack tab="series" />;
}
