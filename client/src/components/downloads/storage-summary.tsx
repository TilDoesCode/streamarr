import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { HardDrive } from '@/components/icons';
import { Text } from '@/components/ui/text';
import { useDownloadStorage } from '@/downloads/hooks';
import { useFormat } from '@/i18n/format';
import { colors, useDesign } from '@/theme';

/** "Streamarr 9.6 GB · other 31 GB · free 6.8 GB" with a bar of the three shares (hidden until the engine answered). */
export function StorageSummary({ testID = 'downloads-storage' }: { testID?: string }) {
  const { t } = useTranslation();
  const design = useDesign();
  const format = useFormat();
  const storage = useDownloadStorage();
  if (!storage || storage.totalBytes <= 0) return null;
  const share = (bytes: number) => `${Math.max(0, (bytes / storage.totalBytes) * 100)}%` as const;
  const values = {
    used: format.fileSize(storage.usedBytes),
    other: format.fileSize(storage.otherBytes),
    free: format.fileSize(storage.freeBytes),
  };
  const height = design.px(6);
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={t('downloads.library.storageA11y', values)}
      style={{ gap: design.space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
        <HardDrive size={design.layout.iconSize.sm} color={colors.foreground.muted} />
        <Text variant="caption" tone="muted" numberOfLines={2} style={{ flex: 1 }}>
          {t('downloads.library.storage', values)}
        </Text>
      </View>
      <View
        style={{
          height,
          borderRadius: height,
          overflow: 'hidden',
          flexDirection: 'row',
          backgroundColor: colors.input,
        }}>
        <View style={{ width: share(storage.usedBytes), backgroundColor: colors.accent.DEFAULT }} />
        <View
          style={{ width: share(storage.otherBytes), backgroundColor: colors.foreground.muted }}
        />
      </View>
    </View>
  );
}
