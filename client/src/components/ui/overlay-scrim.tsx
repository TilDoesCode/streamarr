import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

/** Full-screen dismiss layer behind a Dialog or Sheet. Web: a click target outside the Tab order (Escape closes). */
export function OverlayScrim({
  onPress,
  clear = false,
  strong = false,
}: {
  onPress: () => void;
  clear?: boolean;
  /** Hides the content behind a translucent panel completely (Android TV glass dialog). */
  strong?: boolean;
}) {
  const { t } = useTranslation();
  const style = [
    StyleSheet.absoluteFill,
    {
      backgroundColor: clear
        ? colors.scrim.clear
        : strong
          ? colors.scrim.strong
          : colors.scrim.DEFAULT,
    },
  ];
  if (Platform.OS === 'web') {
    return (
      <View
        aria-hidden
        style={style}
        onStartShouldSetResponder={() => true}
        onResponderRelease={onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={t('a11y.dismiss')}
      focusable={false}
      onPress={onPress}
      style={style}
    />
  );
}
