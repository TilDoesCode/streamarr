import { useTranslation } from 'react-i18next';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, useDesign } from '@/theme';

export type ProgressBarProps = {
  /** 0..1 */
  value: number;
  /** Drawn over artwork: dark track so it stays visible on bright images. */
  onMedia?: boolean;
  size?: 'sm' | 'md';
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function ProgressBar({
  value,
  onMedia = false,
  size = 'sm',
  accessibilityLabel,
  style,
}: ProgressBarProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const progress = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const height = design.px(size === 'sm' ? 3 : 5);
  return (
    <View
      accessible
      role="progressbar"
      accessibilityLabel={accessibilityLabel ?? t('a11y.progress', { progress })}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
      style={[
        {
          height,
          borderRadius: height,
          overflow: 'hidden',
          backgroundColor: onMedia ? colors.scrim.DEFAULT : colors.input,
        },
        style,
      ]}>
      <View
        style={{
          width: `${progress * 100}%`,
          height: '100%',
          borderRadius: height,
          backgroundColor: colors.accent.DEFAULT,
        }}
      />
    </View>
  );
}
