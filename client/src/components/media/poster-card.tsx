import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import type { ArtworkSizes } from '@/lib/artwork';
import { CardCaption, PlayedMark, useCardScale } from '@/components/media/card-parts';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import type { CatalogSpec } from '@/components/spec';
import { useShell } from '@/shell/use-shell';
import { aspect, useDesign } from '@/theme';

export type PosterCardProps = Omit<FocusableProps, 'children'> & {
  title: string;
  subtitle?: string;
  imageUri?: string | null;
  /** Size classes of the image (B10): the card loads the one that fits its width. */
  imageSizes?: ArtworkSizes | null;
  /** 0..1 watch progress; hidden when played. */
  progress?: number;
  played?: boolean;
  badge?: string;
  width?: number;
  /** Signal spec summary (large shell). */
  spec?: CatalogSpec | null;
  /** Title tint for the focus glow. */
  tint?: string | null;
};

export function PosterCard({
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
}: PosterCardProps) {
  const design = useDesign();
  const cardWidth = width ?? design.layout.posterWidth;
  const height = cardWidth / aspect.poster;
  const shell = useShell();
  const radius = shell.large ? shell.s(20) : design.radius.md;
  const scale = useCardScale(cardWidth);
  const inset = design.space.sm;
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
            request={{ kind: 'poster', cssWidth: cardWidth, scale }}
            title={title}
          />
          {badge ? (
            <View style={{ position: 'absolute', top: inset, left: inset }}>
              <Badge label={badge} variant="solid" />
            </View>
          ) : null}
          {played ? <PlayedMark /> : null}
          {!played && progress != null && progress > 0 ? (
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
        maxSpec={2}
        revealOnFocus={design.isTV && !shell.large}
      />
    </Focusable>
  );
}
