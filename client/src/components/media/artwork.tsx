import { Image, type ImageContentFit } from 'expo-image';
import { Clapperboard } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

export type ArtworkProps = {
  uri?: string | null;
  /** Shown in the fallback when the image is missing or fails to load. */
  title?: string;
  contentFit?: ImageContentFit;
  style?: StyleProp<ViewStyle>;
  /** Decorative artwork next to a visible title is hidden from screen readers. */
  decorative?: boolean;
};

/** Poster/backdrop/still with a designed fallback; fills its parent (absolute). */
export function Artwork({
  uri,
  title,
  contentFit = 'cover',
  style,
  decorative = true,
}: ArtworkProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const [failed, setFailed] = useState<string | null>(null);
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
          transition={200}
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
