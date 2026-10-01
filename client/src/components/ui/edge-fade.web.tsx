import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

export type EdgeFadeProps = {
  start: number;
  end: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** Horizontal soft edges through a CSS mask. */
export function EdgeFade({ start, end, style, children }: EdgeFadeProps) {
  const mask = {
    maskImage: `linear-gradient(to right, ${start ? 'transparent' : 'black'} 0px, black ${start}px, black calc(100% - ${end}px), ${end ? 'transparent' : 'black'} 100%)`,
  } as unknown as ViewStyle;
  return <View style={[style, mask]}>{children}</View>;
}
