import { useShell } from '@/shell/use-shell';

import { LargeShell } from './large-shell';
import { WebShell } from './web-shell';

/** Signed-in tab shell on the web: the large-screen shell; a top bar on phone-width windows. */
export function AppTabs() {
  return useShell().large ? <LargeShell /> : <WebShell />;
}
