import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'index' };

export default function HomeTabLayout() {
  return <TabStack tab="home" />;
}
