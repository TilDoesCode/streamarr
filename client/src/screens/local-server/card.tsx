import type { ReactNode } from 'react';
import { View } from 'react-native';

import { colors, useDesign } from '@/theme';

/** Raised panel of the local-server page. */
export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const design = useDesign();
  return (
    <View
      testID={testID}
      style={{
        padding: design.space.lg,
        gap: design.space.md,
        borderRadius: design.radius.lg,
        borderCurve: 'continuous',
        backgroundColor: colors.surface.raised,
      }}>
      {children}
    </View>
  );
}
