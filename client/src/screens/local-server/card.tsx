import type { ReactNode } from 'react';
import { View } from 'react-native';

import { FocusGuide } from '@/components/focus';
import { colors, useDesign, useFocusGap } from '@/theme';

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

/** Buttons side by side; unlike `SettingsButtonRow` Right is not trapped, so it reaches the other column on TV. */
export function ActionRow({ children }: { children: ReactNode }) {
  const design = useDesign();
  const gap = useFocusGap(design.space.md);
  return (
    <FocusGuide remember style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {children}
    </FocusGuide>
  );
}
