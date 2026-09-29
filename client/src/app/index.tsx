import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { LayoutGrid } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { platformKey } from '@/lib/platform';
import { colors, useDesign } from '@/theme';

// Placeholder until the navigation shells (M2.4) replace it with Home.
export default function IndexScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const design = useDesign();
  const logo = design.px(design.isTV ? 96 : 80);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: design.space['2xl'],
          padding: design.layout.gutter,
        }}>
        <View style={{ alignItems: 'center', gap: design.space.md }}>
          <Image
            source={require('@/assets/images/splash-icon.png')}
            style={{ width: logo, height: logo }}
            contentFit="contain"
            accessibilityIgnoresInvertColors
          />
          <Text variant="display">{t('app.name')}</Text>
          <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
            {t('app.tagline')}
          </Text>
        </View>
        <Text variant="callout" tone="subtle" style={{ textAlign: 'center' }}>
          {t('home.placeholder')}
        </Text>
        {__DEV__ ? (
          <Button
            testID="open-gallery"
            label={t('home.openGallery')}
            icon={LayoutGrid}
            variant="secondary"
            hasTVPreferredFocus
            onPress={() => router.push('/dev/gallery')}
          />
        ) : null}
        <Text testID="platform-info" variant="caption" tone="subtle">
          {t('platform.running', { platform: t(`platform.${platformKey()}`) })}
        </Text>
      </View>
    </SafeAreaView>
  );
}
