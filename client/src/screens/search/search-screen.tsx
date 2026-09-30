import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { toAppError } from '@/api/errors';
import type { components } from '@/api/schema';
import { PosterCard } from '@/components/media/poster-card';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { PosterCardSkeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { titleHref } from '@/navigation/routes';
import { accountKey } from '@/query/keys';
import { colors, useDesign } from '@/theme';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 350;
// Server maximum (ViewerCatalogService.MaxSearchResults); more is rejected as invalid_query.
const SEARCH_LIMIT = 20;

type SearchItem = components['schemas']['CatalogItemDto'];

function itemKey(item: SearchItem, index = 0): string {
  return item.workId ?? `${item.tmdbId}-${index}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    rows.push(items.slice(start, start + size));
  return rows;
}

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Search tab: title search as you type (M4.1 adds filters and recent searches). */
export function SearchScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { account, client } = useActiveAccount();
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  // Window width until the first layout (TV: the rail takes part of it).
  const [width, setWidth] = useState(design.window.width);
  const results = useQuery({
    queryKey: accountKey(account.id, 'catalog', 'search', query),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/search', {
          params: { query: { q: query, type: 'any', limit: SEARCH_LIMIT } },
          signal,
        })
      ).then((response) => response.items ?? []),
    enabled: query.length >= MIN_QUERY,
    placeholderData: (previous) => previous,
  });

  const { gutter, cardGap, posterWidth } = design.layout;
  const columns = Math.max(2, Math.floor((width - 2 * gutter + cardGap) / (posterWidth + cardGap)));
  const cardWidth = Math.floor((width - 2 * gutter - (columns - 1) * cardGap) / columns);
  const pageHeading = design.isTV || Platform.OS === 'web';
  const active = query.length >= MIN_QUERY;
  const items = active ? (results.data ?? []) : [];
  // Rows instead of numColumns: a column change would remount the list and the focused search field with it.
  const rows = chunk(items, columns);

  const header = (
    <View
      style={{ paddingHorizontal: gutter, gap: design.space.lg, paddingBottom: design.space.lg }}>
      {pageHeading ? <Text variant="title">{t('tabs.search')}</Text> : null}
      <TextField
        testID="search-field"
        label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        initialFocus={Platform.OS === 'web'}
      />
    </View>
  );

  const body = () => {
    if (!active)
      return (
        <EmptyState
          testID="search-idle"
          icon={Search}
          title={t('search.promptTitle')}
          message={t('search.promptMessage')}
        />
      );
    if (results.error && !results.data)
      return (
        <ErrorState
          testID="search-error"
          code={toAppError(results.error).code}
          actions={toAppError(results.error).isTransient ? ['retry'] : []}
          onAction={() => void results.refetch()}
        />
      );
    if (!results.data)
      return (
        <View
          testID="search-loading"
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: cardGap,
            paddingHorizontal: gutter,
          }}>
          {Array.from({ length: columns * 2 }, (_, index) => (
            <PosterCardSkeleton key={index} width={cardWidth} />
          ))}
        </View>
      );
    return (
      <EmptyState
        testID="search-empty"
        icon={Search}
        title={t('states.emptySearch.title', { query })}
        message={t('states.emptySearch.message')}
      />
    );
  };

  return (
    <View
      testID="search-screen"
      style={{ flex: 1, backgroundColor: colors.background }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.map(itemKey).join('|')}
        ListHeaderComponent={header}
        ListEmptyComponent={body()}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingTop: pageHeading ? design.layout.edgeVertical + insets.top : design.space.lg,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        }}
        renderItem={({ item: row, index: rowIndex }) => (
          <View
            style={{
              flexDirection: 'row',
              gap: cardGap,
              paddingHorizontal: gutter,
              marginBottom: cardGap,
            }}>
            {row.map((item, column) => {
              const index = rowIndex * columns + column;
              return (
                <PosterCard
                  key={itemKey(item, index)}
                  testID={`search-result-${index}`}
                  title={item.title ?? ''}
                  subtitle={item.year ? String(item.year) : undefined}
                  imageUri={item.posterUrl}
                  width={cardWidth}
                  onPress={() => router.push(titleHref(item))}
                />
              );
            })}
          </View>
        )}
      />
    </View>
  );
}
