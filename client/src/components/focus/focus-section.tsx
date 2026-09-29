import { createContext, useState, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useDesign } from '@/theme';

/** Scroll-snap alignment every Focusable inside applies to itself (TV, sections taller than the screen). */
export const ItemSnapContext = createContext<'center' | undefined>(undefined);

export type FocusSectionProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Page block for TV item-snap ScrollViews: snaps its top when it fits the screen, else centres the focused item. */
export function FocusSection({ children, style, testID }: FocusSectionProps) {
  const design = useDesign();
  const [height, setHeight] = useState(0);
  const ringRoom = design.focus.ringOffset + design.focus.ringWidth + design.space.xs;
  const fits = height <= design.window.height - 2 * design.layout.edgeVertical - ringRoom;
  const tall = design.isTV && !fits;
  return (
    <View
      testID={testID}
      collapsable={false}
      scrollSnapAlign={design.isTV && fits ? 'start' : undefined}
      onLayout={
        design.isTV ? (event) => setHeight(Math.ceil(event.nativeEvent.layout.height)) : undefined
      }
      style={style}>
      <ItemSnapContext value={tall ? 'center' : undefined}>{children}</ItemSnapContext>
    </View>
  );
}
