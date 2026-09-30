import { TabStack } from '@/navigation/tab-stack';

export const unstable_settings = { initialRouteName: 'settings' };

export default function SettingsTabLayout() {
  return <TabStack tab="settings" />;
}
