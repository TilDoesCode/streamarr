import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import type { ArtworkSizes } from '@/lib/artwork';
import { CardCaption, CardHairline, PlayedMark, useCardScale } from '@/components/media/card-parts';
import { Scrim } from '@/components/media/scrim';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import type { CatalogSpec } from '@/components/spec';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, colors, useDesign } from '@/theme';

export type LandscapeCardProps = Omit<FocusableProps, 'children'> & {
  title: string;
  subtitle?: string;
  imageUri?: string | null;
  /** Size classes of the image (B10): the card loads the one that fits its width. */
  imageSizes?: ArtworkSizes | null;
  progress?: number;
  played?: boolean;
  badge?: string;
  width?: number;
  /** Signal spec summary (large shell). */
  spec?: CatalogSpec | null;
  /** Title tint for the focus glow. */
  tint?: string | null;
};

/** 16:9 card for continue watching, episodes and backdrops. */
export function LandscapeCard({
  title,
  subtitle,
  imageUri,
  imageSizes,
  progress,
  played = false,
  badge,
  width,
  spec,
  tint,
  style,
  ...props
}: LandscapeCardProps) {
  const design = useDesign();
  const cardWidth = width ?? design.layout.landscapeWidth;
  const height = cardWidth / aspect.landscape;
  const shell = useShell();
  const radius = shell.large ? shell.s(SHELL.card.radius) : design.radius.md;
  const scale = useCardScale(cardWidth);
  const inset = design.space.sm;
  const hasProgress = !played && progress != null && progress > 0;
  return (
    <Focusable
      role="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={[{ width: cardWidth }, style]}
      {...props}>
      <FocusLift kind="card" radius={radius} tint={tint} scale={scale}>
        <View
          style={{
            width: cardWidth,
            height,
            borderRadius: radius,
            borderCurve: 'continuous',
            overflow: 'hidden',
          }}>
          <Artwork
            uri={imageUri}
            sizes={imageSizes}
            request={{ kind: 'backdrop', cssWidth: cardWidth, scale }}
            title={title}
          />
          {hasProgress ? (
            <Scrim
              color={colors.scrim.DEFAULT}
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.45 }}
            />
          ) : null}
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
      <CardCaption
        title={title}
        subtitle={subtitle}
        artworkHeight={height}
        scale={scale}
        spec={spec}
        maxSpec={3}
      />
    </Focusable>
  );
}
