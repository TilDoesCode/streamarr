import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

export type StatusActionProps = {
  testID?: string;
  label: string;
  primary: boolean;
  onPress: () => void;
};

/** A hint's action on touch and web: a plain pill, because WebKit paints a glass one empty (S9a D10). */
export function StatusAction({ testID, label, primary, onPress }: StatusActionProps) {
  const design = useDesign();
  const height = design.layout.controlHeight.md;
  // Keyboard focus on web gets the app's focus ring (RN Web hides the browser outline, review R6).
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      testID={testID}
      role="button"
      accessibilityLabel={label}
      hasTVPreferredFocus={false}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, flexShrink: 0 })}>
      <View
        testID={testID ? `${testID}-pill` : undefined}
        style={{
          minHeight: height,
          borderRadius: height / 2,
          paddingHorizontal: design.space.lg,
          justifyContent: 'center',
          backgroundColor: primary ? colors.primary.DEFAULT : colors.secondary.DEFAULT,
          borderWidth: 2,
          borderColor: focused ? colors.focus.DEFAULT : 'transparent',
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
