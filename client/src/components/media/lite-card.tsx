import { View } from 'react-native';

import { Focusable, FocusLift } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { CardHairline, PlayedMark, useCardScale } from '@/components/media/card-parts';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import type { ArtworkKind } from '@/lib/artwork';
import { MIN_TEXT, SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { LITE_CARD_SCALE } from '@/performance';
import { aspect, colors, fonts, useDesign } from '@/theme';

import type { LandscapeCardProps } from './landscape-card';
import type { PosterCardProps } from './poster-card';

/** Lite cards accept a class up to this much narrower than the drawn pixels (TV 1080p: posters w185, stills w300). */
export const LITE_UPSCALE = 1.25;

type LiteCardProps = PosterCardProps & { kind: ArtworkKind };

/** Lean card for weak TV hardware: artwork with a small timed lift and a ring, static caption; no glow, shadow or animated text. */
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
  const cardWidth = width ?? (poster ? design.layout.posterWidth : design.layout.landscapeWidth);
  const height = cardWidth / (poster ? aspect.poster : aspect.landscape);
  const radius = large ? s(SHELL.card.radius) : design.radius.md;
  const inset = design.space.sm;
  const hasProgress = !played && progress != null && progress > 0;
  const scale = Math.min(useCardScale(cardWidth), LITE_CARD_SCALE);
  // The caption stays put: it starts below the lifted artwork.
  const captionTop = Math.max(large ? s(14) : design.space.sm, ((scale - 1) * height) / 2 + s(6));
  return (
    <Focusable
      role="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={[{ width: cardWidth }, style]}
      {...props}>
      <FocusLift kind="card" radius={radius} scale={scale} style={{ width: cardWidth, height }}>
        <View
          testID="lite-card-art"
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
      </FocusLift>
      <View style={{ paddingTop: captionTop, gap: large ? s(2) : 0 }}>
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
