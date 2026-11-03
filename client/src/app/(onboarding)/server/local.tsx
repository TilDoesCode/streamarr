import { LocalServerScreen } from '@/screens/local-server/local-server-screen';
import { ShellDesign } from '@/shell/shell-design';

/** Outside the (app) gate: reachable before any account exists, from Settings and via streamarr://server/local. */
export default function LocalServerRoute() {
  return (
    <ShellDesign>
      <LocalServerScreen />
    </ShellDesign>
  );
}
