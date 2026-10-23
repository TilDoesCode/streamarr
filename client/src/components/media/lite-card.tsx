import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, useFocusState } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { CardHairline, PlayedMark } from '@/components/media/card-parts';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import type { ArtworkKind } from '@/lib/artwork';
import { MIN_TEXT, SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, colors, fonts, useDesign } from '@/theme';

import type { LandscapeCardProps } from './landscape-card';
import type { PosterCardProps } from './poster-card';

/** Lite cards accept a class up to this much narrower than the drawn pixels (TV 1080p: posters w185, stills w300). */
export const LITE_UPSCALE = 1.25;

type LiteCardProps = PosterCardProps & { kind: ArtworkKind };

/** Lite focus: the ring only shows or hides (no lift, glow, spring or caption motion). */
function LiteRing({ radius }: { radius: number }) {
  const design = useDesign();
  const { focus } = useFocusState();
  const style = useAnimatedStyle(() => ({ opacity: focus.get() > 0.5 ? 1 : 0 }));
  const offset = design.focus.ringOffset;
  const width = Math.max(design.focus.ringWidth, design.px(2));
  return (
    <Animated.View
      testID="lite-card-ring"
      style={[
        {
          pointerEvents: 'none',
          position: 'absolute',
          top: -offset - width,
          left: -offset - width,
          right: -offset - width,
          bottom: -offset - width,
          borderRadius: radius + offset + width,
          borderWidth: width,
          borderColor: colors.focus.DEFAULT,
        },
        style,
      ]}
    />
  );
}

/** Flat card for weak TV hardware: artwork, ring, static caption; no scale, shadow or animated text. */
export function LiteCard({
  kind,
  title,
  subtitle,
  imageUri,
  imageSizes,
  progress,
  played = false,
  badge,
  width,
  spec: _spec,
  tint: _tint,
  style,
  ...props
}: LiteCardProps) {
  const design = useDesign();
  const { large, s, font } = useShell();
  const poster = kind === 'poster';
  const cardWidth =
    width ?? (poster ? design.layout.posterWidth : design.layout.landscapeWidth);
  const height = cardWidth / (poster ? aspect.poster : aspect.landscape);
  const radius = large ? s(SHELL.card.radius) : design.radius.md;
  const inset = design.space.sm;
  const hasProgress = !played && progress != null && progress > 0;
  return (
    <Focusable
      role="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={[{ width: cardWidth }, style]}
      {...props}>
      <View testID="lite-card-art" style={{ width: cardWidth, height }}>
        <View
          style={{
            width: cardWidth,
            height,
            borderRadius: radius,
            overflow: 'hidden',
            backgroundColor: colors.surface.DEFAULT,
          }}>
          <Artwork
            uri={imageUri}
            sizes={imageSizes}
            request={{ kind, cssWidth: cardWidth, upscale: LITE_UPSCALE }}
            title={title}
          />
          {badge ? (
            <View style={{ position: 'absolute', top: inset, left: inset }}>
              <Badge label={badge} variant="solid" />
            </View>
          ) : null}
          {played ? <PlayedMark /> : null}
          <CardHairline radius={radius} />
          {hasProgress ? (
            <ProgressBar
              value={progress}
              onMedia
              style={{ position: 'absolute', left: inset, right: inset, bottom: inset }}
            />
          ) : null}
        </View>
        <LiteRing radius={radius} />
      </View>
      <View style={{ paddingTop: large ? s(14) : design.space.sm, gap: large ? s(2) : 0 }}>
        <Text
          numberOfLines={1}
          style={
            large
              ? {
                  fontFamily: fonts.bodySemiBold,
                  fontSize: font(SHELL.type.cardTitle, MIN_TEXT.caption),
                  lineHeight: font(28, MIN_TEXT.caption + 5),
                  color: colors.foreground.DEFAULT,
                }
              : [design.type.callout, { color: colors.foreground.DEFAULT }]
          }>
          {title}
        </Text>
        {subtitle ? (
          <Text
            variant="caption"
            tone="subtle"
            numberOfLines={1}
            style={
              large && {
                fontSize: font(SHELL.type.cardSubline, MIN_TEXT.subline),
                lineHeight: font(24, MIN_TEXT.subline + 5),
              }
            }>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Focusable>
  );
}

export function LitePosterCard(props: PosterCardProps) {
  return <LiteCard kind="poster" {...props} />;
}

export function LiteLandscapeCard(props: LandscapeCardProps) {
  return <LiteCard kind="backdrop" {...props} />;
}
