import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'mylist' };

export default function MyListTabLayout() {
  return <TabStack tab="mylist" />;
}
