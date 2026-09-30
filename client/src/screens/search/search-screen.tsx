import { useRouter } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { toAppError } from '@/api/errors';
import { useSearch, type CatalogItem, type SearchType } from '@/browse/queries';
import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { PosterCard } from '@/components/media/poster-card';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PosterCardSkeleton } from '@/components/ui/skeleton';
import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import {
  addRecentSearch,
  clearRecentSearches,
  removeRecentSearch,
  useRecentSearches,
} from '@/lib/recent-searches';
import { titleHref } from '@/navigation/routes';
import { useScreenTitle } from '@/navigation/screen-title';
import { colors, useDesign } from '@/theme';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 350;
const TYPES: readonly SearchType[] = ['any', 'movie', 'tv'];

type SearchItem = CatalogItem;

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

/** Search tab: debounced title search with a type filter and this profile's recent searches. */
export function SearchScreen() {
  const { t } = useTranslation();
  useScreenTitle(t('tabs.search'));
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { account } = useActiveAccount();
  const [text, setText] = useState('');
  const [type, setType] = useState<SearchType>('any');
  // Another profile starts with a fresh search (the screen stays mounted across a switch).
  const [searchAccount, setSearchAccount] = useState(account.id);
  if (searchAccount !== account.id) {
    setSearchAccount(account.id);
    setText('');
    setType('any');
  }
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  const recent = useRecentSearches(account.id);
  // Window width until the first layout (TV: the rail takes part of it).
  const [width, setWidth] = useState(design.window.width);
  const results = useSearch(query, type, query.length >= MIN_QUERY);
  const remember = () => addRecentSearch(account.id, text);

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
        onSubmitEditing={remember}
        initialFocus={Platform.OS === 'web'}
        trailing={
          text && !design.isTV ? (
            <IconButton
              testID="search-clear"
              icon={X}
              size="sm"
              variant="ghost"
              accessibilityLabel={t('search.clear')}
              onPress={() => setText('')}
            />
          ) : undefined
        }
      />
      <FocusGuide
        remember
        trap={END_OF_ROW}
        role="radiogroup"
        aria-label={t('search.filter')}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
        {TYPES.map((value) => (
          <Tag
            key={value}
            testID={`search-type-${value}`}
            role="radio"
            aria-checked={type === value}
            label={t(`search.types.${value}`)}
            selected={type === value}
            onPress={() => setType(value)}
          />
        ))}
      </FocusGuide>
    </View>
  );

  const recentSearches = recent.length ? (
    <View testID="search-recent" style={{ paddingHorizontal: gutter, gap: design.space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="heading">{t('search.recent')}</Text>
        <Button
          testID="search-recent-clear"
          size="sm"
          variant="ghost"
          label={t('search.clearRecent')}
          onPress={() => clearRecentSearches(account.id)}
        />
      </View>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
        {recent.map((item, index) => (
          <Tag
            key={item}
            testID={`search-recent-${index}`}
            label={item}
            onPress={() => setText(item)}
            onLongPress={() => removeRecentSearch(account.id, item)}
          />
        ))}
      </FocusGuide>
    </View>
  ) : null;

  const body = () => {
    if (!active)
      return (
        recentSearches ?? (
          <EmptyState
            testID="search-idle"
            icon={Search}
            title={t('search.promptTitle')}
            message={t('search.promptMessage')}
          />
        )
      );
    if (results.error && !results.data)
      return (
        <ErrorState
          testID="search-error"
          code={toAppError(results.error).code}
          params={toAppError(results.error).params}
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
                  subtitle={[
                    t(
                      item.mediaType === 'tv' || item.mediaType === 'series'
                        ? 'detail.series'
                        : 'detail.movie'
                    ),
                    item.year ? String(item.year) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  imageUri={item.posterUrl}
                  width={cardWidth}
                  onPress={() => {
                    remember();
                    router.push(titleHref(item));
                  }}
                />
              );
            })}
          </View>
        )}
      />
    </View>
  );
}
