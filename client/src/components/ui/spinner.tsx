import { useTranslation } from 'react-i18next';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useLoaderMotion } from '@/components/ui/loader-motion';
import { colors, useDesign } from '@/theme';

const SIZES = { sm: 16, md: 24, lg: 40 } as const;

const SPIN = {
  from: { transform: [{ rotate: '0deg' }] },
  to: { transform: [{ rotate: '360deg' }] },
};

export type SpinnerProps = {
  size?: keyof typeof SIZES;
  color?: string;
  accessibilityLabel?: string;
  /** false renders a static arc (e.g. while UI automation needs an idle screen). */
  animated?: boolean;
  testID?: string;
};

/** Indeterminate progress. Rotation stays under reduced motion (it carries the meaning), just slower. */
export function Spinner({
  size = 'md',
  color = colors.foreground.DEFAULT,
  accessibilityLabel,
  animated = true,
  testID,
}: SpinnerProps) {
  const { t } = useTranslation();
  const motionAllowed = useLoaderMotion();
  const { px } = useDesign();
  const reduced = useReducedMotion();
  const dimension = px(SIZES[size]);
  const stroke = Math.max(2, dimension / 10);
  const r = (dimension - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <Animated.View
      testID={testID}
      accessible
      role="progressbar"
      accessibilityLabel={accessibilityLabel ?? t('a11y.loading')}
      style={{
        width: dimension,
        height: dimension,
        animationName: animated && motionAllowed ? SPIN : undefined,
        animationDuration: reduced ? '1600ms' : '800ms',
        animationIterationCount: 'infinite',
        animationTimingFunction: 'linear',
      }}>
      <Svg width={dimension} height={dimension}>
        <Circle
          cx={dimension / 2}
          cy={dimension / 2}
          r={r}
          stroke={color}
          strokeOpacity={0.2}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={dimension / 2}
          cy={dimension / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference}`}
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}
