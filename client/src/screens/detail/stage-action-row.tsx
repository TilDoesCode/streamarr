import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useShell } from '@/shell/use-shell';
import { useFocusGap } from '@/theme';

/** The Bühne's Play/Resume/Start over row: TV gaps leave room for the focus lift and ring. */
export function StageActionRow({ children }: { children: ReactNode }) {
  const { s } = useShell();
  const gap = useFocusGap(s(28));
  return (
    <View
      testID="stage-actions"
      style={{ flexDirection: 'row', alignItems: 'center', gap, marginTop: s(12) }}>
      {children}
    </View>
  );
}
