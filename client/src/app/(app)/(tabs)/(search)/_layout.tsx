import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'search' };

export default function SearchTabLayout() {
  return <TabStack tab="search" />;
}
