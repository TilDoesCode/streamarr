import { View } from 'react-native';

import { colors, useDesign } from '@/theme';

import { SPEC_TONES } from './spec-label';
import type { SignalLevel, SpecTone } from './spec-model';

const HEIGHTS = [0.4, 0.6, 0.8, 1];

/** Four ascending bars: health / local state of a version (4 = ready or instant, 2 = degraded or preparing). */
export function SignalBars({
  level,
  tone = 'ok',
  size = 14,
  accessibilityLabel,
  testID,
}: {
  level: SignalLevel;
  tone?: SpecTone;
  size?: number;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const design = useDesign();
  const height = design.px(size);
  const barWidth = Math.max(2, Math.round(height / 5));
  return (
    <View
      testID={testID}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: barWidth / 2, height }}>
      {HEIGHTS.map((fraction, index) => (
        <View
          key={fraction}
          style={{
            width: barWidth,
            height: height * fraction,
            borderRadius: barWidth / 2,
            backgroundColor: index < level ? SPEC_TONES[tone].fg : colors.glass.strong,
          }}
        />
      ))}
    </View>
  );
}
