import type { ReactNode } from 'react';
import { View } from 'react-native';

import { FocusGuide, FocusSection } from '@/components/focus';
import { colors, useDesign, useFocusGap } from '@/theme';

/** Raised panel of the local-server page; a TV scroll-snap block (`pageTop` scrolls back to the heading). */
export function Card({
  children,
  testID,
  pageTop,
}: {
  children: ReactNode;
  testID?: string;
  pageTop?: boolean;
}) {
  const design = useDesign();
  return (
    <FocusSection testID={testID} pageTop={pageTop}>
      <View
        style={{
          padding: design.space.lg,
          gap: design.space.md,
          borderRadius: design.radius.lg,
          borderCurve: 'continuous',
          backgroundColor: colors.surface.raised,
        }}>
        {children}
      </View>
    </FocusSection>
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
