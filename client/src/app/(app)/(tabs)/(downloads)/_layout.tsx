import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'downloads' };

export default function DownloadsTabLayout() {
  return <TabStack tab="downloads" />;
}
