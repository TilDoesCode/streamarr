import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

/** `streamarr://server/local` (Streamybox Settings → "Open in Streamarr"); the real screen replaces this placeholder. */
export default function LocalServerScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <View
      testID="local-server-screen"
      style={{ flex: 1, padding: design.layout.gutter, backgroundColor: colors.background }}>
      <Text variant="title">{t('devServer.title')}</Text>
      <Text tone="muted">{t('devServer.placeholder')}</Text>
    </View>
  );
}
