import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { StatusBarScrim } from '@/components/media/scrim';
import { useDesign } from '@/theme';

import { useShell } from './use-shell';

/** Android phone pages draw edge to edge: content scrolled under the status bar gets the scrim (iOS: UIKit's scroll-edge effect). */
export function StatusBarScrimLayer({ children, testID }: { children: ReactNode; testID: string }) {
  const shell = useShell();
  const design = useDesign();
  if (Platform.OS !== 'android' || shell.large || design.isTV) return children;
  return (
    <View style={{ flex: 1 }}>
      {children}
      <StatusBarScrim testID={testID} />
    </View>
  );
}
