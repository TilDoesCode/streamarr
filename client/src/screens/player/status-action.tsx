import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

export type StatusActionProps = {
  testID?: string;
  label: string;
  primary: boolean;
  onPress: () => void;
};

/**
 * A hint's action (touch and web only; TV hints have none). A plain pill: no glass backdrop, no lift transform and no
 * single-line clamp, which WebKit paints as an empty pill inside the glass card (S9a D10, iPhone Safari).
 */
export function StatusAction({ testID, label, primary, onPress }: StatusActionProps) {
  const design = useDesign();
  const height = design.layout.controlHeight.md;
  return (
    <Pressable
      testID={testID}
      role="button"
      accessibilityLabel={label}
      hasTVPreferredFocus={false}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, flexShrink: 0 })}>
      <View
        style={{
          minHeight: height,
          borderRadius: height / 2,
          paddingHorizontal: design.space.lg,
          justifyContent: 'center',
          backgroundColor: primary ? colors.primary.DEFAULT : colors.secondary.DEFAULT,
        }}>
        <Text
          testID={testID ? `${testID}-label` : undefined}
          variant="label"
          style={{
            color: primary ? colors.primary.foreground : colors.secondary.foreground,
            textAlign: 'center',
          }}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
