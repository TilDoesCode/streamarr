import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Film } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import type { components } from '@/api/schema';
import { displayServerUrl } from '@/api/server-url';
import { PosterCard } from '@/components/media/poster-card';
import { Shelf } from '@/components/media/shelf';
import { titleHref } from '@/navigation/routes';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { PosterCardSkeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { queryKeys } from '@/query/keys';
import { accountPersister } from '@/query/persist';
import { STALE } from '@/query/query-client';
import { aspect, colors, useDesign } from '@/theme';

type Row = components['schemas']['CatalogRowDto'];
type Item = components['schemas']['CatalogItemDto'];

const ROW_KEYS = [
  'trending-movies',
  'trending-series',
  'popular-movies',
  'popular-series',
] as const;
type RowKey = (typeof ROW_KEYS)[number];

function rowKey(id: string | null): RowKey | 'other' {
  return ROW_KEYS.includes(id as RowKey) ? (id as RowKey) : 'other';
}

/** Discover rows of the active account; persisted per account in MMKV so they show instantly. */
export function useHomeRows() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: queryKeys.discover(account.id),
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/viewer/catalog/discover', { signal })).then(
        (response) => response.rows ?? []
      ),
    staleTime: STALE.homeRows,
    persister: accountPersister(account.id).persisterFn,
  });
}

/** Home tab: greeting and the live discover rows (M4.1 adds hero, continue watching and next up). */
export function HomeScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { account } = useActiveAccount();
  const rows = useHomeRows();
  const posterWidth = design.layout.posterWidth;

  return (
    <View testID="home-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: design.isTV ? design.layout.edgeVertical : insets.top + design.space.lg,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          gap: design.layout.sectionGap,
        }}
        snapToAlignment={design.isTV ? 'item' : undefined}
        snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: design.space.lg,
            paddingHorizontal: design.layout.gutter,
          }}>
          <Avatar
            name={account.displayName}
            color={account.color}
            size={design.px(design.isTV ? 44 : 48)}
          />
          <View style={{ flex: 1, gap: design.space.xxs }}>
            <Text testID="home-greeting" variant="title" numberOfLines={1}>
              {t('home.greeting', { name: account.displayName })}
            </Text>
            <Text variant="callout" tone="muted" numberOfLines={1}>
              {rows.isFetching && rows.data
                ? t('home.updating')
                : t('home.server', {
                    server: t('onboarding.serverChip', {
                      name: account.serverName,
                      url: displayServerUrl(account.serverUrl),
                    }),
                  })}
            </Text>
          </View>
        </View>
        <HomeRows rows={rows} posterWidth={posterWidth} />
      </ScrollView>
    </View>
  );
}

function HomeRows({
  rows,
  posterWidth,
}: {
  rows: ReturnType<typeof useHomeRows>;
  posterWidth: number;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const artworkHeight = posterWidth / aspect.poster;

  if (rows.data === undefined) {
    if (rows.error)
      return (
        <ErrorState
          testID="home-error"
          code={toAppError(rows.error).code}
          actions={['retry']}
          onAction={() => void rows.refetch()}
        />
      );
    return (
      <View testID="home-loading" style={{ gap: design.layout.sectionGap }}>
        {[0, 1].map((row) => (
          <View
            key={row}
            style={{
              flexDirection: 'row',
              gap: design.layout.cardGap,
              paddingHorizontal: design.layout.gutter,
              overflow: 'hidden',
            }}>
            {Array.from({ length: 8 }, (_, index) => (
              <PosterCardSkeleton key={index} width={posterWidth} />
            ))}
          </View>
        ))}
      </View>
    );
  }

  const visible = rows.data.filter((row): row is Row & { items: Item[] } => !!row.items?.length);
  return (
    <>
      {rows.error ? (
        <View style={{ paddingHorizontal: design.layout.gutter }}>
          <FormMessage
            testID="home-refresh-error"
            tone="warning"
            title={describeError(t, toAppError(rows.error)).title}
            actions={
              <Button
                size="sm"
                variant="secondary"
                label={t('common.retry')}
                onPress={() => void rows.refetch()}
              />
            }
          />
        </View>
      ) : null}
      {visible.length ? (
        visible.map((row, rowIndex) => (
          <Shelf
            key={row.id ?? rowIndex}
            testID={`home-row-${row.id}`}
            memoryKey={`home-${row.id}`}
            title={t(`home.rows.${rowKey(row.id)}`)}
            data={row.items}
            keyExtractor={(item, itemIndex) => item.workId ?? String(itemIndex)}
            itemWidth={posterWidth}
            artworkHeight={artworkHeight}
            renderItem={({ item, index }) => (
              <PosterCard
                testID={`home-card-${row.id}-${index}`}
                title={item.title ?? ''}
                subtitle={item.year ? String(item.year) : undefined}
                imageUri={item.posterUrl}
                width={posterWidth}
                hasTVPreferredFocus={rowIndex === 0 && index === 0}
                onPress={() => router.push(titleHref(item))}
              />
            )}
          />
        ))
      ) : (
        <EmptyState
          testID="home-empty"
          icon={Film}
          title={t('states.empty.title')}
          message={t('states.empty.message')}
        />
      )}
    </>
  );
}
