import type { ReactNode } from 'react';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, Focusable, FocusLift, FocusSection } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

/** Titled gallery block (a FocusSection: TV snapping adapts to its height). */
export function GallerySection({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  const design = useDesign();
  return (
    <FocusSection
      testID={testID}
      style={{ paddingHorizontal: design.layout.gutter, gap: design.space.lg }}>
      <Text variant="heading">{title}</Text>
      {children}
    </FocusSection>
  );
}

/** A remembered focus row of items that wraps on narrow screens. */
export function GalleryRow({
  children,
  align = 'center',
}: {
  children: ReactNode;
  align?: 'center' | 'flex-start';
}) {
  const design = useDesign();
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: align, gap: design.space.lg }}>
      {children}
    </FocusGuide>
  );
}

/** An item with a small caption naming the state it shows. */
export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  const design = useDesign();
  return (
    <View style={{ gap: design.space.sm, alignItems: 'center' }}>
      {children}
      <Text variant="caption" tone="subtle">
        {label}
      </Text>
    </View>
  );
}

/** Non-interactive content still needs a focus stop on TV, or the remote can never scroll to it. */
export function FocusStop({ testID, children }: { testID?: string; children: ReactNode }) {
  const design = useDesign();
  return (
    <Focusable testID={testID} style={{ alignSelf: 'flex-start' }}>
      <FocusLift kind="none" radius={design.radius.md}>
        {children}
      </FocusLift>
    </Focusable>
  );
}
