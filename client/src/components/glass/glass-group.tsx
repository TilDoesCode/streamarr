import { View, type ViewProps } from 'react-native';

export type GlassGroupProps = ViewProps & { spacing?: number };

/** Groups glass pieces so iOS 26 can merge them; a plain View elsewhere. */
export function GlassGroup({ spacing: _spacing, ...props }: GlassGroupProps) {
  return <View {...props} />;
}
