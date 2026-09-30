import type { ReactNode } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

export type GlassIntensity = 'subtle' | 'regular' | 'strong';

export type GlassProps = Omit<ViewProps, 'style'> & {
  /** Surfaces (panels, rails, strips) are passive; controls (player buttons, chips) are interactive. */
  interactive?: boolean;
  intensity?: GlassIntensity;
  /** Optional title tint washed into the glass. */
  tint?: string | null;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};
