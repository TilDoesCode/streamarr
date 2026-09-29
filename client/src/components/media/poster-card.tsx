import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { CardCaption, PlayedMark } from '@/components/media/card-parts';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { aspect, useDesign } from '@/theme';

export type PosterCardProps = Omit<FocusableProps, 'children'> & {
  title: string;
  subtitle?: string;
  imageUri?: string | null;
  /** 0..1 watch progress; hidden when played. */
  progress?: number;
  played?: boolean;
  badge?: string;
  width?: number;
};

export function PosterCard({
  title,
  subtitle,
  imageUri,
  progress,
  played = false,
  badge,
  width,
  style,
  ...props
}: PosterCardProps) {
  const design = useDesign();
  const cardWidth = width ?? design.layout.posterWidth;
  const height = cardWidth / aspect.poster;
  const radius = design.radius.md;
  const inset = design.space.sm;
  return (
    <Focusable
      role="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={[{ width: cardWidth }, style]}
      {...props}>
      <FocusLift kind="card" radius={radius}>
        <View
          style={{
            width: cardWidth,
            height,
            borderRadius: radius,
            borderCurve: 'continuous',
            overflow: 'hidden',
          }}>
          <Artwork uri={imageUri} title={title} />
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
      <CardCaption title={title} subtitle={subtitle} artworkHeight={height} />
    </Focusable>
  );
}
