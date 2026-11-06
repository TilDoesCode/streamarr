import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import type { DownloadStorage } from '@/downloads';
import { useFormat } from '@/i18n/format';
import { colors, useDesign } from '@/theme';

/** Streamarr · other · free on the device's download volume, as one bar with a legend. */
export function StorageBar({
  storage,
  testID = 'download-storage',
}: {
  storage: DownloadStorage | null;
  testID?: string;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  if (!storage || storage.totalBytes <= 0)
    return (
      <View
        testID={`${testID}-pending`}
        style={{ height: design.px(8), borderRadius: 4, backgroundColor: colors.glass.subtle }}
      />
    );
  const share = (bytes: number) =>
    `${Math.max(0, Math.min(100, (bytes / storage.totalBytes) * 100))}%` as const;
  const parts = [
    {
      key: 'app',
      bytes: storage.usedBytes,
      color: colors.accent.DEFAULT,
      label: t('downloads.screen.storage.app'),
    },
    {
      key: 'other',
      bytes: storage.otherBytes,
      color: colors.foreground.subtle,
      label: t('downloads.screen.storage.other'),
    },
    {
      key: 'free',
      bytes: storage.freeBytes,
      color: colors.glass.strong,
      label: t('downloads.screen.storage.free'),
    },
  ];
  return (
    <View
      testID={testID}
      accessibilityLabel={parts
        .map((part) => `${part.label} ${format.fileSize(part.bytes)}`)
        .join(', ')}
      style={{ gap: design.space.sm }}>
      <View
        style={{
          flexDirection: 'row',
          height: design.px(8),
          borderRadius: design.px(4),
          overflow: 'hidden',
          backgroundColor: colors.glass.subtle,
        }}>
        {parts.map((part) => (
          <View key={part.key} style={{ width: share(part.bytes), backgroundColor: part.color }} />
        ))}
      </View>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: design.space.lg,
          rowGap: design.space.xs,
        }}>
        {parts.map((part) => (
          <View
            key={part.key}
            style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.xs }}>
            <View
              style={{
                width: design.px(10),
                height: design.px(10),
                borderRadius: design.px(5),
                backgroundColor: part.color,
              }}
            />
            <Text testID={`${testID}-${part.key}`} variant="caption" tone="muted">
              {`${part.label} ${format.fileSize(part.bytes)}`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
