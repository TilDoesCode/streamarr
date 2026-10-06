import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';

import { useLoaderMotion } from '@/components/ui/loader-motion';
import { aspect, colors, motion, useDesign } from '@/theme';

const PULSE = {
  '0%': { opacity: 1 },
  '50%': { opacity: 0.45 },
  '100%': { opacity: 1 },
};

export type SkeletonProps = {
  width?: DimensionValue;
  height?: DimensionValue;
  aspectRatio?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  animated?: boolean;
  testID?: string;
};

/** Placeholder block for content with a known layout. Pulses; static under reduced motion. */
export function Skeleton({
  width = '100%',
  height,
  aspectRatio,
  radius,
  style,
  animated = true,
  testID,
}: SkeletonProps) {
  const design = useDesign();
  const motionAllowed = useLoaderMotion();
  const reduced = useReducedMotion();
  return (
    <Animated.View
      testID={testID}
      aria-hidden
      style={[
        {
          width,
          height,
          aspectRatio,
          borderRadius: radius ?? design.radius.md,
          borderCurve: 'continuous',
          backgroundColor: colors.surface.raised,
        },
        animated &&
          motionAllowed &&
          !reduced && {
            animationName: PULSE,
            animationDuration: `${motion.pulse}ms`,
            animationIterationCount: 'infinite',
            animationTimingFunction: 'ease-in-out',
          },
        style,
      ]}
    />
  );
}

export function SkeletonText({
  width = '60%',
  variant = 'body',
}: {
  width?: DimensionValue;
  variant?: 'body' | 'caption' | 'heading';
}) {
  const design = useDesign();
  const step = design.type[variant];
  return (
    <Skeleton
      width={width}
      height={Math.round(step.fontSize * 0.8)}
      radius={design.radius.sm}
      style={{ marginVertical: (step.lineHeight - step.fontSize * 0.8) / 2 }}
    />
  );
}

export function PosterCardSkeleton({ width }: { width?: number }) {
  const design = useDesign();
  const w = width ?? design.layout.posterWidth;
  return <Skeleton width={w} aspectRatio={aspect.poster} />;
}

export function LandscapeCardSkeleton({ width }: { width?: number }) {
  const design = useDesign();
  const w = width ?? design.layout.landscapeWidth;
  return (
    <Animated.View style={{ width: w, gap: design.space.sm }}>
      <Skeleton width={w} aspectRatio={aspect.landscape} />
      <SkeletonText width="70%" variant="body" />
      <SkeletonText width="40%" variant="caption" />
    </Animated.View>
  );
}
