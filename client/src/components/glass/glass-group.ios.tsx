import {
  GlassContainer,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { View, type ViewProps } from 'react-native';

export type GlassGroupProps = ViewProps & { spacing?: number };

const LIQUID = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/** iOS 26: GlassContainer so neighbouring GlassViews merge; a plain View below. */
export function GlassGroup({ spacing, ...props }: GlassGroupProps) {
  return LIQUID ? <GlassContainer spacing={spacing} {...props} /> : <View {...props} />;
}
