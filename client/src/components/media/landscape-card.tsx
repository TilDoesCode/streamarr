import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { CardCaption, PlayedMark } from '@/components/media/card-parts';
import { Scrim } from '@/components/media/scrim';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { aspect, colors, useDesign } from '@/theme';

export type LandscapeCardProps = Omit<FocusableProps, 'children'> & {
  title: string;
  subtitle?: string;
  imageUri?: string | null;
  progress?: number;
  played?: boolean;
  badge?: string;
  width?: number;
};

/** 16:9 card for continue watching, episodes and backdrops. */
export function LandscapeCard({
  title,
  subtitle,
  imageUri,
  progress,
  played = false,
  badge,
  width,
  style,
  ...props
}: LandscapeCardProps) {
  const design = useDesign();
  const cardWidth = width ?? design.layout.landscapeWidth;
  const height = cardWidth / aspect.landscape;
  const radius = design.radius.md;
  const inset = design.space.sm;
  const hasProgress = !played && progress != null && progress > 0;
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
          {hasProgress ? (
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
