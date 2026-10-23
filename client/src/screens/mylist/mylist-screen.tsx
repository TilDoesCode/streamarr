import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import { useWatchRefreshOnFocus } from '@/browse/queries';
import { useOpenTitle, usePrefetchTitle } from '@/browse/title-open';
import { Bookmark } from '@/components/icons';
import { PosterCard } from '@/components/media/poster-card';
import { Shelf } from '@/components/media/shelf';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { PosterCardSkeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { useMarkListSeen, useMyList, type MyListItem } from '@/mylist/queries';
import {
  listProgress,
  listSections,
  listSubline,
  listTarget,
  listTitle,
  type ListSection,
} from '@/mylist/sections';
import { useScreenTitle } from '@/navigation/screen-title';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, colors, gutterPadding, useDesign } from '@/theme';

const MEMORY = 'mylist:';

/** My List: new episodes, continue, want to watch, caught up and watched as rows of posters. */
export function MyListScreen() {
  const { t } = useTranslation();
  useScreenTitle(t('tabs.mylist'));
  const design = useDesign();
  const shell = useShell();
  const insets = useSafeAreaInsets();
  const list = useMyList();
  useWatchRefreshOnFocus();
  const posterWidth = shell.large ? shell.s(SHELL.poster.width) : design.layout.posterWidth;
  const items = list.data?.items ?? [];
  const sections = listSections(items);
  const newCount = items.filter((item) => item.isNew).length;

  const body = () => {
    if (list.isPending)
      return (
        <View
          testID="mylist-loading"
          style={{ flexDirection: 'row', gap: design.space.md, ...gutterPadding(design) }}>
          {[0, 1, 2, 3].map((index) => (
            <PosterCardSkeleton key={index} width={posterWidth} />
          ))}
        </View>
      );
    if (list.error && !list.data)
      return (
        <ErrorState
          testID="mylist-error"
          code={toAppError(list.error).code}
          actions={['retry']}
          onAction={() => void list.refetch()}
        />
      );
    if (!sections.length)
      return (
        <EmptyState
          testID="mylist-empty"
          icon={Bookmark}
          title={t('mylist.empty.title')}
          message={t('mylist.empty.message')}
        />
      );
    return sections.map((section, index) => (
      <ListShelf key={section.key} section={section} width={posterWidth} first={index === 0} />
    ));
  };

  return (
    <ScrollView
      testID="mylist-screen"
      style={{ flex: 1, backgroundColor: shell.large ? undefined : colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={!shell.large}
      contentContainerStyle={{
        paddingTop: shell.large ? shell.s(SHELL.page.top) : design.layout.edgeVertical + insets.top,
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        gap: design.layout.sectionGap,
      }}>
      <View style={{ ...gutterPadding(design), gap: design.space.xs }}>
        <Text variant="title" role="heading" numberOfLines={1} style={shell.pageTitle}>
          {t('tabs.mylist')}
        </Text>
        {newCount ? (
          <Text testID="mylist-new-count" variant="callout" tone="accent">
            {t('mylist.newCount', { count: newCount })}
          </Text>
        ) : null}
      </View>
      {body()}
    </ScrollView>
  );
}

function ListShelf({
  section,
  width,
  first,
}: {
  section: ListSection;
  width: number;
  first: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Shelf
      testID={`mylist-row-${section.key}`}
      memoryKey={`${MEMORY}${section.key}`}
      title={t(`mylist.sections.${section.key}`)}
      data={section.items}
      keyExtractor={(item) => item.workId ?? ''}
      itemWidth={width}
      artworkHeight={width / aspect.poster}
      renderItem={({ item, index }) => (
        <ListCard item={item} width={width} preferFocus={first && index === 0} />
      )}
    />
  );
}

/** Poster with the NEW badge, the progress bar and "S2, E5 · 12/20"; opens the title (and clears NEW). */
export function ListCard({
  item,
  width,
  preferFocus = false,
}: {
  item: MyListItem;
  width: number;
  preferFocus?: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const openTitle = useOpenTitle();
  const prefetch = usePrefetchTitle();
  const seen = useMarkListSeen();
  const { target, preview } = listTarget(item);
  return (
    <PosterCard
      testID={`mylist-item-${item.workId}`}
      title={listTitle(item)}
      subtitle={listSubline(item, t, format.date)}
      imageUri={item.posterUrl}
      imageSizes={item.posterSizes}
      width={width}
      tint={item.tint}
      badge={item.isNew ? t('mylist.newBadge') : undefined}
      progress={listProgress(item)}
      played={item.status === 'watched'}
      hasTVPreferredFocus={preferFocus}
      onFocus={() => prefetch.schedule(target)}
      onBlur={prefetch.cancel}
      onPress={() => {
        if (item.isNew && item.workId) seen.mutate(item.workId);
        openTitle(target, preview);
      }}
    />
  );
}
