import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import { useVersions } from '@/browse/queries';
import { VersionPanelCard } from '@/browse/version-panel';
import { ErrorState } from '@/components/states/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { playHref } from '@/navigation/routes';
import { useDesign } from '@/theme';

/** iPhone: native formSheet with transparent content, so iOS 26 draws the sheet in Liquid Glass. */
export function VersionSheetScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    workId: string;
    title?: string;
    current?: string;
    start?: string;
  }>();
  const versions = useVersions(params.workId);
  const list = versions.data?.versions ?? [];
  const title = params.title ?? '';
  const error = versions.error && !versions.data ? toAppError(versions.error) : undefined;

  return (
    <ScrollView
      testID="version-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: design.layout.gutter,
        paddingBottom: insets.bottom + design.space.xl,
        gap: design.space.sm,
      }}>
      <View style={{ gap: design.space.xxs, marginBottom: design.space.sm }}>
        <Text variant="heading">{t('versions.title')}</Text>
        <Text variant="caption" tone="muted">
          {versions.data ? t('versions.subtitle', { title, count: list.length }) : title}
        </Text>
      </View>
      {error ? (
        <ErrorState
          testID="versions-error"
          code={error.code}
          actions={['retry']}
          onAction={() => void versions.refetch()}
        />
      ) : null}
      {!versions.data && !error
        ? [0, 1, 2].map((index) => <Skeleton key={index} height={140} radius={20} />)
        : null}
      {list.map((version, index) => (
        <VersionPanelCard
          key={version.releaseId ?? index}
          version={version}
          current={!!params.current && version.releaseId === params.current}
          onPress={() => {
            router.back();
            router.push(
              playHref({
                workId: params.workId,
                title,
                releaseId: version.releaseId,
                startSeconds: params.start ? Number(params.start) : undefined,
              })
            );
          }}
        />
      ))}
    </ScrollView>
  );
}
