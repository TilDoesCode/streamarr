import { Image, type ImageContentFit, type ImageProps } from 'expo-image';
import { Clapperboard } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { artworkFor, type ArtworkRequest, type ArtworkSizes } from '@/lib/artwork';
import { useMotionPolicy } from '@/performance';
import { colors, useDesign } from '@/theme';

export type ArtworkProps = {
  uri?: string | null;
  /** Size classes of `uri` (B10); `request` picks the one that fits the drawn size. */
  sizes?: ArtworkSizes | null;
  request?: ArtworkRequest;
  /** Shown in the fallback when the image is missing or fails to load. */
  title?: string;
  contentFit?: ImageContentFit;
  style?: StyleProp<ViewStyle>;
  /** Decorative artwork next to a visible title is hidden from screen readers. */
  decorative?: boolean;
  /** Hero and detail backdrops load before the cards around them. */
  priority?: ImageProps['priority'];
  /** Crossfade (ms) to a new image; defaults to the motion policy's fade-in. */
  transition?: number;
};

/** Poster/backdrop/still with a designed fallback; fills its parent (absolute). */
export function Artwork({
  uri: plainUri,
  sizes,
  request,
  title,
  contentFit = 'cover',
  style,
  decorative = true,
  priority,
  transition,
}: ArtworkProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const policy = useMotionPolicy();
  const [failed, setFailed] = useState<string | null>(null);
  const uri = request ? artworkFor(sizes, plainUri, request) : plainUri;
  const showImage = !!uri && failed !== uri;
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface.DEFAULT }, style]}
      aria-hidden={decorative}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit={contentFit}
          // Lite mode: no fade-in, a loaded image is drawn once (the lite hero asks for its crossfade).
          transition={transition ?? (policy.imageFadeIn ? 200 : 0)}
          // Android's default (disk only) decodes the hero's backdrop again on the detail page and on every return.
          cachePolicy="memory-disk"
          priority={priority}
          recyclingKey={uri}
          accessibilityIgnoresInvertColors
          onError={() => setFailed(uri)}
        />
      ) : (
        <View
          accessibilityLabel={t('a11y.artworkMissing')}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: design.space.sm,
            padding: design.space.md,
          }}>
          <Clapperboard size={design.px(22)} color={colors.foreground.subtle} strokeWidth={1.75} />
          {title ? (
            <Text variant="caption" tone="subtle" numberOfLines={3} style={{ textAlign: 'center' }}>
              {title}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
