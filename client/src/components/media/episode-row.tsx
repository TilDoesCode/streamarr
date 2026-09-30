import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, FocusLift, useFocusState, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { PlayedMark } from '@/components/media/card-parts';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { aspect, colors, useDesign } from '@/theme';

export type EpisodeRowProps = Omit<FocusableProps, 'children'> & {
  episodeNumber: number;
  title: string;
  overview?: string;
  stillUri?: string | null;
  runtimeMinutes?: number;
  airDate?: string;
  progress?: number;
  played?: boolean;
  /** No release available: shown dimmed with a badge, not focusable. */
  unavailable?: boolean;
  /** Large detail: the version panel shows this episode (accent bar). */
  selected?: boolean;
};

/** Full-width episode row. Rows highlight (not scale) on focus; the ring marks the TV cursor. */
export function EpisodeRow({
  episodeNumber,
  title,
  overview,
  stillUri,
  runtimeMinutes,
  airDate,
  progress,
  played = false,
  unavailable = false,
  selected = false,
  disabled,
  ...props
}: EpisodeRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const radius = design.radius.lg;
  const meta = [
    t('media.episodeNumber', { episode: episodeNumber }),
    runtimeMinutes ? format.duration(runtimeMinutes * 60) : null,
    airDate ? format.date(airDate, 'medium') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Focusable
      role="button"
      accessibilityLabel={`${meta}. ${title}`}
      disabled={disabled || unavailable}
      aria-selected={selected || undefined}
      {...props}>
      <FocusLift kind="none" radius={radius}>
        {selected ? (
          <View
            testID="episode-row-selected"
            style={{
              position: 'absolute',
              zIndex: 1,
              left: 0,
              top: radius,
              bottom: radius,
              width: 4,
              borderRadius: 2,
              backgroundColor: colors.accent.DEFAULT,
            }}
          />
        ) : null}
        <EpisodeRowSurface radius={radius} dimmed={unavailable}>
          <View
            style={{
              width: design.layout.episodeThumbWidth,
              aspectRatio: aspect.landscape,
              borderRadius: design.radius.md,
              borderCurve: 'continuous',
              overflow: 'hidden',
            }}>
            <Artwork uri={stillUri} title={title} />
            {played ? <PlayedMark /> : null}
            {!played && progress != null && progress > 0 ? (
              <ProgressBar
                value={progress}
                onMedia
                style={{
                  position: 'absolute',
                  left: design.space.sm,
                  right: design.space.sm,
                  bottom: design.space.sm,
                }}
              />
            ) : null}
          </View>
          <View style={{ flex: 1, gap: design.space.xs, justifyContent: 'center' }}>
            <Text variant="caption" tone="subtle" numberOfLines={1}>
              {meta}
            </Text>
            <Text variant="subheading" numberOfLines={1}>
              {title}
            </Text>
            {overview ? (
              <Text variant="callout" tone="muted" numberOfLines={design.isTV ? 2 : 3}>
                {overview}
              </Text>
            ) : null}
            {unavailable ? <Badge label={t('media.unavailable')} variant="outline" /> : null}
          </View>
        </EpisodeRowSurface>
      </FocusLift>
    </Focusable>
  );
}

function EpisodeRowSurface({
  radius,
  dimmed,
  children,
}: {
  radius: number;
  dimmed: boolean;
  children: ReactNode;
}) {
  const design = useDesign();
  const { focus, pressed, hover } = useFocusState();
  const surfaceStyle = useAnimatedStyle(() => {
    const lit = Math.max(focus.get(), hover.get() * 0.6, pressed.get());
    return {
      backgroundColor: interpolateColor(lit, [0, 1], [colors.scrim.clear, colors.surface.raised]),
    };
  });
  return (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          gap: design.space.lg,
          padding: design.space.sm,
          borderRadius: radius,
          borderCurve: 'continuous',
          opacity: dimmed ? 0.5 : 1,
        },
        surfaceStyle,
      ]}>
      {children}
    </Animated.View>
  );
}
