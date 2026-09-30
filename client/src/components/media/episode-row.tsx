import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { PlayedMark } from '@/components/media/card-parts';
import { SpecLabels, type CatalogSpec } from '@/components/spec';
import { Badge } from '@/components/ui/badge';
import { IconButton, type IconButtonProps } from '@/components/ui/icon-button';
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
  spec?: CatalogSpec | null;
  /** Aired and known, but no release yet: "No versions yet" instead of the spec chips. */
  noVersions?: boolean;
  /** Row actions (EpisodeRowAction), inside the row's box on its right side, focusable on their own. */
  actions?: ReactNode;
};

type Light = (key: string, on: boolean) => void;
const RowLight = createContext<Light>(() => {});

/** An icon button inside an EpisodeRow's box; focusing or hovering it lights the whole row. */
export function EpisodeRowAction({
  onFocus,
  onBlur,
  onHoverIn,
  onHoverOut,
  ...props
}: IconButtonProps) {
  const light = useContext(RowLight);
  const key = props.testID ?? String(props.accessibilityLabel);
  return (
    <IconButton
      size="sm"
      variant="ghost"
      onFocus={(event) => {
        light(`${key}:focus`, true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        light(`${key}:focus`, false);
        onBlur?.(event);
      }}
      onHoverIn={(event) => {
        light(`${key}:hover`, true);
        onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        light(`${key}:hover`, false);
        onHoverOut?.(event);
      }}
      {...props}
    />
  );
}

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
  spec,
  noVersions = false,
  actions,
  disabled,
  style,
  onFocus,
  onBlur,
  onHoverIn,
  onHoverOut,
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
    <EpisodeRowBox radius={radius} dimmed={unavailable} style={style}>
      {(light) => (
        <>
          <Focusable
            role="button"
            accessibilityLabel={`${meta}. ${title}`}
            disabled={disabled || unavailable}
            aria-selected={selected || undefined}
            style={{ flex: 1 }}
            onFocus={(event) => {
              light('row:focus', true);
              onFocus?.(event);
            }}
            onBlur={(event) => {
              light('row:focus', false);
              onBlur?.(event);
            }}
            onHoverIn={(event) => {
              light('row:hover', true);
              onHoverIn?.(event);
            }}
            onHoverOut={(event) => {
              light('row:hover', false);
              onHoverOut?.(event);
            }}
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
              <View
                style={{ flexDirection: 'row', gap: design.space.lg, padding: design.space.sm }}>
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
                  {unavailable || noVersions ? (
                    <Badge
                      label={t(noVersions ? 'common.noVersions' : 'media.unavailable')}
                      variant="outline"
                    />
                  ) : (
                    <SpecLabels spec={spec} max={design.isTV ? 4 : 3} />
                  )}
                </View>
              </View>
            </FocusLift>
          </Focusable>
          {actions ? (
            <RowLight.Provider value={light}>
              <View style={{ gap: design.space.sm, paddingRight: design.space.md }}>{actions}</View>
            </RowLight.Provider>
          ) : null}
        </>
      )}
    </EpisodeRowBox>
  );
}

/** The row's glass box: lit while the row or one of its actions has focus or hover. */
function EpisodeRowBox({
  radius,
  dimmed,
  style,
  children,
}: {
  radius: number;
  dimmed: boolean;
  style: FocusableProps['style'];
  children: (light: Light) => ReactNode;
}) {
  const lit = useSharedValue(0);
  const [sources] = useState(() => new Set<string>());
  const light = useCallback<Light>(
    (key, on) => {
      if (on) sources.add(key);
      else sources.delete(key);
      lit.set(withTiming(sources.size ? 1 : 0, { duration: 150 }));
    },
    [lit, sources]
  );
  const surfaceStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(lit.get(), [0, 1], [colors.scrim.clear, colors.glass.strong]),
    borderColor: interpolateColor(lit.get(), [0, 1], [colors.scrim.clear, colors.glass.highlight]),
  }));
  return (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderRadius: radius,
          borderCurve: 'continuous',
          opacity: dimmed ? 0.5 : 1,
        },
        style,
        surfaceStyle,
      ]}>
      {children(light)}
    </Animated.View>
  );
}
