import { SettingsScreen } from '@/screens/settings/settings-screen';
import { ShellDesign } from '@/shell/shell-design';

export default function SettingsRoute() {
  return (
    <ShellDesign>
      <SettingsScreen />
    </ShellDesign>
  );
}
