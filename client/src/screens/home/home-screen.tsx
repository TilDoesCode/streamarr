import { Film } from 'lucide-react-native';
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { displayServerUrl } from '@/api/server-url';
import {
  useContinueWatching,
  useHomeRows,
  useNextUp,
  type CatalogItem,
  type CatalogRow,
} from '@/browse/queries';
import { Shelf } from '@/components/media/shelf';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { LandscapeCardSkeleton, PosterCardSkeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { aspect, colors, useDesign } from '@/theme';

import { FeaturedStore } from './featured';
import { ContinueCard, DiscoverCard, featuredFromItem, NextUpCard } from './home-cards';
import { HandheldHomeHero, TvHomeBackdrop, TvHomeInfo } from './home-hero';

export { useHomeRows } from '@/browse/queries';

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

type ShelfSpec = {
  key: string;
  title: string;
  kind: 'landscape' | 'poster';
  items: readonly unknown[];
  render: (index: number, preferred: boolean) => ReactElement;
  itemKey: (index: number) => string;
};

/** Home: hero, continue watching, next up and the discover rows. TV: the hero follows the focused card. */
export function HomeScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { account } = useActiveAccount();
  const rows = useHomeRows();
  const resume = useContinueWatching();
  const nextUp = useNextUp();
  const [store] = useState(() => new FeaturedStore());
  useEffect(() => () => store.dispose(), [store]);

  const discover = (rows.data ?? []).filter(
    (row): row is CatalogRow & { items: CatalogItem[] } => !!row.items?.length
  );
  const continueItems = resume.data ?? [];
  const resumeIds = new Set(continueItems.map((item) => item.workId));
  const nextItems = (nextUp.data ?? []).filter((item) => !resumeIds.has(item.workId));
  const firstItem = discover[0]?.items[0];
  const firstRowTitle = discover[0] ? t(`home.rows.${rowKey(discover[0].id)}`) : '';
  const topPick = firstItem ? featuredFromItem(firstItem, firstRowTitle) : undefined;
  useEffect(() => store.initial(topPick), [store, topPick]);

  const feature = design.isTV
    ? (item: Parameters<FeaturedStore['set']>[0]) => store.set(item)
    : undefined;
  const { posterWidth, landscapeWidth } = design.layout;
  const continueTitle = t('home.continueWatching');
  const nextTitle = t('home.nextUp');

  const shelves: ShelfSpec[] = [];
  if (continueItems.length)
    shelves.push({
      key: 'continue',
      title: continueTitle,
      kind: 'landscape',
      items: continueItems,
      itemKey: (index) => continueItems[index]?.workId ?? String(index),
      render: (index, preferred) => (
        <ContinueCard
          testID={`home-card-continue-${index}`}
          state={continueItems[index]!}
          width={landscapeWidth}
          eyebrow={continueTitle}
          onFeature={feature}
          hasTVPreferredFocus={preferred}
        />
      ),
    });
  if (nextItems.length)
    shelves.push({
      key: 'next-up',
      title: nextTitle,
      kind: 'landscape',
      items: nextItems,
      itemKey: (index) => nextItems[index]?.workId ?? String(index),
      render: (index, preferred) => (
        <NextUpCard
          testID={`home-card-next-up-${index}`}
          item={nextItems[index]!}
          width={landscapeWidth}
          eyebrow={nextTitle}
          onFeature={feature}
          hasTVPreferredFocus={preferred}
        />
      ),
    });
  for (const row of discover) {
    const title = t(`home.rows.${rowKey(row.id)}`);
    shelves.push({
      key: row.id ?? title,
      title,
      kind: 'poster',
      items: row.items,
      itemKey: (index) => row.items[index]?.workId ?? String(index),
      render: (index, preferred) => (
        <DiscoverCard
          testID={`home-card-${row.id}-${index}`}
          item={row.items[index]!}
          width={posterWidth}
          eyebrow={title}
          onFeature={feature}
          hasTVPreferredFocus={preferred}
        />
      ),
    });
  }

  const failed = [rows, resume, nextUp].filter((query) => query.error);
  const retryAll = () => {
    for (const query of [rows, resume, nextUp]) if (query.error) void query.refetch();
  };
  const loading = rows.data === undefined && !rows.error;

  const body =
    rows.data === undefined && rows.error ? (
      <ErrorState
        testID="home-error"
        code={toAppError(rows.error).code}
        actions={['retry']}
        autoFocus
        onAction={retryAll}
      />
    ) : loading ? (
      <HomeSkeleton />
    ) : (
      <>
        {failed.length ? (
          <View style={{ paddingHorizontal: design.layout.gutter }}>
            <FormMessage
              testID="home-refresh-error"
              tone="warning"
              title={describeError(t, toAppError(failed[0]!.error)).title}
              actions={
                <Button
                  testID="home-refresh-retry"
                  size="sm"
                  variant="secondary"
                  label={t('common.retry')}
                  onPress={retryAll}
                />
              }
            />
          </View>
        ) : null}
        {shelves.length ? (
          shelves.map((shelf, shelfIndex) => {
            const width = shelf.kind === 'poster' ? posterWidth : landscapeWidth;
            return (
              <Shelf
                key={shelf.key}
                testID={`home-row-${shelf.key}`}
                memoryKey={`home-${shelf.key}`}
                title={shelf.title}
                data={shelf.items}
                keyExtractor={(_, index) => shelf.itemKey(index)}
                itemWidth={width}
                artworkHeight={width / (shelf.kind === 'poster' ? aspect.poster : aspect.landscape)}
                renderItem={({ index }) => shelf.render(index, shelfIndex === 0 && index === 0)}
              />
            );
          })
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

  if (design.isTV)
    return (
      <View testID="home-screen" style={{ flex: 1, backgroundColor: colors.background }}>
        <TvHomeBackdrop store={store} />
        <TvHomeInfo store={store} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingBottom: design.layout.edgeVertical + design.space['3xl'],
            gap: design.layout.sectionGap,
          }}
          snapToAlignment="item"
          snapToItemPadding={0}>
          {body}
        </ScrollView>
      </View>
    );

  return (
    <View testID="home-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          gap: design.layout.sectionGap,
        }}>
        <View>
          {topPick ? (
            <HandheldHomeHero featured={topPick} />
          ) : loading ? (
            <View style={{ height: design.layout.heroHeight }} />
          ) : null}
          <View
            style={{
              position: topPick || loading ? 'absolute' : 'relative',
              top: insets.top + design.space.lg,
              left: 0,
              right: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: design.space.md,
              paddingHorizontal: design.layout.gutter,
              paddingTop: topPick || loading ? 0 : insets.top + design.space.lg,
            }}>
            <Avatar name={account.displayName} color={account.color} size={design.px(36)} />
            <View style={{ flex: 1 }}>
              <Text testID="home-greeting" variant="subheading" numberOfLines={1}>
                {t('home.greeting', { name: account.displayName })}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
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
        </View>
        {body}
      </ScrollView>
    </View>
  );
}

function HomeSkeleton() {
  const design = useDesign();
  return (
    <View testID="home-loading" style={{ gap: design.layout.sectionGap }}>
      {(['landscape', 'poster'] as const).map((kind) => (
        <View
          key={kind}
          style={{
            flexDirection: 'row',
            gap: design.layout.cardGap,
            paddingHorizontal: design.layout.gutter,
            overflow: 'hidden',
          }}>
          {Array.from({ length: 8 }, (_, index) =>
            kind === 'poster' ? (
              <PosterCardSkeleton key={index} width={design.layout.posterWidth} />
            ) : (
              <LandscapeCardSkeleton key={index} width={design.layout.landscapeWidth} />
            )
          )}
        </View>
      ))}
    </View>
  );
}
