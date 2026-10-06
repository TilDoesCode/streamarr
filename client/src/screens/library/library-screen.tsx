import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Film, Tv } from '@/components/icons';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findNodeHandle, FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCardGap } from '@/components/media/card-parts';
import { toAppError } from '@/api/errors';
import {
  LIBRARY_SORTS,
  libraryItems,
  libraryParams,
  type LibraryKind,
  type LibraryParams,
  type LibrarySort,
} from '@/browse/library';
import { useGenres, useLibrary, type CatalogItem } from '@/browse/queries';
import { useClearAmbient, useSetAmbient, type AmbientInput } from '@/components/ambient';
import {
  END_OF_ROW,
  FocusGuide,
  FocusMemoryContext,
  Focusable,
  FocusLift,
  useBackHandler,
  useFocusGlowRoom,
  menuPressInTabBar,
} from '@/components/focus';
import { Glass } from '@/components/glass';
import { PosterCard } from '@/components/media/poster-card';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { PosterCardSkeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { titleHref } from '@/navigation/routes';
import { useFocusRail } from '@/navigation/screen-focus';
import { useScreenTitle } from '@/navigation/screen-title';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, gutterPadding, useDesign, useFocusGap } from '@/theme';

import { GenreRow } from './genre-row';
import {
  applyLibraryFilter,
  backToChip,
  libraryBack,
  type LibraryZone,
  useLibraryMenuClaim,
} from './library-back';

// Request the next page while the last loaded rows are this close to the viewport.
const PAGING_ROWS = 2;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    rows.push(items.slice(start, start + size));
  return rows;
}

function itemKey(item: CatalogItem): string {
  return item.workId ?? `${item.mediaType}-${item.tmdbId}`;
}

/** Title-safe margin of a TV screen in 1080 shell points. */
const TITLE_SAFE = 54;

const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

/** Movies or Series page: genre chips, sort, a paged poster grid with loading, empty and error states. */
export function LibraryScreen({ kind }: { kind: LibraryKind }) {
  const { t } = useTranslation();
  const tab = kind === 'movie' ? 'movies' : 'series';
  useScreenTitle(t(`tabs.${tab}`));
  const design = useDesign();
  const shell = useShell();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const setAmbient = useSetAmbient();
  const clearAmbient = useClearAmbient();
  const focusRail = useFocusRail();
  const { genre, sort } = libraryParams(useLocalSearchParams<LibraryParams>());
  const genres = useGenres(kind);
  const library = useLibrary(kind, genre, sort);
  const items = libraryItems(library.data?.pages);

  const [size, setSize] = useState(design.window);
  const [selectedGenreNode, setSelectedGenreNode] = useState<View | null>(null);
  const [rowEnd, setRowEnd] = useState<View | null>(null);
  const selectedGenre = useRef<View>(null);
  useEffect(() => setSelectedGenreNode(selectedGenre.current), [genre, genres.data]);
  const width = size.width;
  const pad = gutterPadding(design);
  const across = pad.paddingLeft + pad.paddingRight;
  const cardGap = useCardGap();
  const posterWidth = shell.large ? shell.s(SHELL.poster.width) : design.layout.posterWidth;
  const columns = Math.max(2, Math.floor((width - across + cardGap) / (posterWidth + cardGap)));
  const cardWidth = shell.large
    ? posterWidth
    : Math.floor((width - across - (columns - 1) * cardGap) / columns);
  const rows = chunk(items, columns);
  const glowRoom = useFocusGlowRoom();
  // TV: a lifted row's ring sits title-safe; the row gap matches, so the row above is fully off screen.
  const liftTop = shell.s(TITLE_SAFE) + glowRoom;
  const rowGap = design.isTV ? Math.max(cardGap, liftTop) : cardGap;

  // The ambient starts on the first title, then follows the focused or hovered card (kept for the return from a title).
  const first = items[0];
  const ambient = useRef<AmbientInput | null>(null);
  const showAmbient = (item: CatalogItem) => {
    ambient.current = ambientOf(item);
    setAmbient(ambient.current);
  };
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      if (!ambient.current && first) ambient.current = ambientOf(first);
      if (ambient.current) setAmbient(ambient.current);
      return () => {
        screenFocused.current = false;
        clearAmbient(ambient.current);
      };
    }, [first, setAmbient, clearAmbient])
  );

  // TV Back chain: grid or sort -> the selected genre chip -> the rail's active tab.
  const zone = useRef<LibraryZone>(null);
  const [menuZone, setMenuZone] = useState<LibraryZone>(null);
  const setZone = (value: LibraryZone) => {
    zone.current = value;
    setMenuZone(value);
  };
  const list = useRef<FlatList<CatalogItem[]>>(null);
  // Apple TV: grid and sort hand Menu to the chain below (one level); at the chips tvOS moves to the tab bar.
  useLibraryMenuClaim(menuZone);
  useBackHandler(() => {
    if (!screenFocused.current) return false;
    const back = libraryBack(zone.current, menuPressInTabBar());
    setZone(back.zone);
    if (back.step === 'rail') focusRail();
    if (back.step === 'chip') backToChip(list.current, () => selectedGenre.current);
    return back.step !== null;
  }, design.isTV);

  // TV: the first row shows the whole header; later rows lift to liftTop with the header scrolled away.
  const liftRow = (rowIndex: number) => {
    if (!design.isTV) return;
    if (rowIndex === 0) list.current?.scrollToOffset({ offset: 0, animated: true });
    else list.current?.scrollToIndex({ index: rowIndex, viewOffset: liftTop, animated: true });
  };

  // A new genre or sort starts at the top: header in view, no lifted row, no memory of the old grid; TV focus on the chip.
  const memory = use(FocusMemoryContext);
  const query = `${genre}|${sort}`;
  const shownQuery = useRef(query);
  // A page opened with a genre (deep link) also starts on its chip.
  const focusChip = useRef(design.isTV && genre !== null);
  useEffect(() => {
    if (shownQuery.current === query) return;
    shownQuery.current = query;
    list.current?.scrollToOffset({ offset: 0, animated: false });
    // A sort change keeps focus in the sort control (it refocuses its new segment).
    const fromSort = zone.current === 'sort';
    setZone(fromSort ? 'sort' : null);
    ambient.current = null;
    memory?.reset?.();
    focusChip.current = design.isTV && !fromSort;
  }, [query, memory, design.isTV]);
  const firstPageShown = !library.isPending;
  useEffect(() => {
    if (!focusChip.current || !firstPageShown || !selectedGenreNode) return;
    const frame = requestAnimationFrame(() => {
      focusChip.current = false;
      const chip = selectedGenre.current;
      if (!chip) return;
      // Also the screen's memory: a tab-entry restore after a deep link from another tab lands on the chip too.
      memory?.remember(chip);
      chip.requestTVFocus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [firstPageShown, query, selectedGenreNode, memory]);

  const setFilter = (next: { genre?: number | null; sort?: LibrarySort }) => {
    const nextGenre = next.genre === undefined ? genre : next.genre;
    const nextSort = next.sort ?? sort;
    const params = {
      genre: nextGenre ? String(nextGenre) : undefined,
      sort: nextSort === 'popular' ? undefined : nextSort,
    };
    applyLibraryFilter(router, params);
  };

  // A genre id the server does not list (old link, other type) falls back to All.
  const knownGenre = !genre || !genres.data || genres.data.some((item) => item.id === genre);
  useEffect(() => {
    if (knownGenre) return;
    applyLibraryFilter(router, { genre: undefined, sort: sort === 'popular' ? undefined : sort });
  }, [knownGenre, router, sort]);

  const loadMore = () => {
    if (library.hasNextPage && !library.isFetchingNextPage && !library.error)
      void library.fetchNextPage();
  };

  // A grid shorter than the viewport never scrolls: keep loading until it covers it plus the paging rows.
  const rowHeight = cardWidth * 1.5 + cardGap + design.space['3xl'];
  const wantedRows = Math.ceil(size.height / rowHeight) + PAGING_ROWS;
  useEffect(() => {
    if (!library.isFetching && library.hasNextPage && !library.error && rows.length < wantedRows)
      void library.fetchNextPage();
  }, [library, rows.length, wantedRows]);

  const genreChips = [
    { id: null as number | null, name: t('library.allGenres') },
    ...(genres.data ?? []).map((item) => ({ id: item.id, name: item.name ?? '' })),
  ];

  // Apple TV puts the sort at the end of the genre line: UIKit only reaches it geometrically (Right from the last chip).
  const sortControl = (
    <SortControl
      value={sort}
      label={t('library.sortLabel')}
      labelOf={(value) => t(`library.sort.${value}`)}
      onChange={(value) => setFilter({ sort: value })}
      onFocus={() => setZone('sort')}
      downTarget={APPLE_TV ? null : selectedGenreNode}
    />
  );
  // One title line (page title + compact sort) above one single-line genre row, on every form factor.
  const header = (
    <View style={{ gap: design.space.md, paddingBottom: design.space.lg }}>
      <View
        testID="library-title-line"
        style={{
          ...pad,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: design.space.lg,
        }}>
        <Text
          variant="title"
          role="heading"
          numberOfLines={1}
          style={[{ flexShrink: 1 }, shell.pageTitle]}>
          {t(`tabs.${tab}`)}
        </Text>
        {APPLE_TV ? null : sortControl}
      </View>
      <GenreRow
        chips={genreChips}
        selected={genre}
        selectedRef={selectedGenre}
        selectedNode={selectedGenreNode}
        label={t('library.genres')}
        onSelect={(id) => setFilter({ genre: id })}
        onChipFocus={() => setZone('genres')}
        trailing={APPLE_TV ? sortControl : undefined}
      />
    </View>
  );

  const skeletons = (count: number, testID: string) => (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: cardGap, ...pad }}>
      {Array.from({ length: count }, (_, index) => (
        <PosterCardSkeleton key={index} width={cardWidth} />
      ))}
    </View>
  );

  const retry = () => void (library.data ? library.fetchNextPage() : library.refetch());
  const errorState = library.error ? (
    <ErrorState
      testID="library-error"
      code={toAppError(library.error).code}
      params={toAppError(library.error).params}
      actions={['retry']}
      onAction={retry}
    />
  ) : null;

  const body = () => {
    if (library.isPending) return skeletons(columns * 2, 'library-loading');
    if (errorState) return errorState;
    return (
      <EmptyState
        testID="library-empty"
        icon={kind === 'movie' ? Film : Tv}
        title={t('library.empty.title')}
        message={t(`library.empty.${kind}`)}
      />
    );
  };

  const footer = library.isFetchingNextPage
    ? skeletons(columns, 'library-loading-more')
    : items.length && library.error
      ? errorState
      : null;

  const grid = (
    <FlatList
      testID={`library-${kind}`}
      // TV lists sit in an unstyled TVFocusGuideView (react-native-tvos), so flex: 1 collapses there.
      style={[
        design.isTV ? { height: size.height } : { flex: 1 },
        { backgroundColor: shell.large ? undefined : colors.background },
      ]}
      onLayout={design.isTV ? undefined : (event) => setSize(event.nativeEvent.layout)}
      ref={list}
      scrollEnabled={!design.isTV}
      removeClippedSubviews={false}
      data={rows}
      extraData={rowEnd}
      keyExtractor={(row) => row.map(itemKey).join('|')}
      ListHeaderComponent={header}
      ListEmptyComponent={body()}
      ListFooterComponent={footer}
      showsVerticalScrollIndicator={!shell.large}
      onEndReached={loadMore}
      onEndReachedThreshold={PAGING_ROWS / Math.max(1, Math.min(rows.length, 4))}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingTop: shell.large ? shell.s(SHELL.page.top) : design.layout.edgeVertical + insets.top,
        // TV: room below the last row so any focused row can scroll up to the page top.
        paddingBottom: design.isTV
          ? Math.max(0, size.height - rowHeight)
          : Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
      }}
      renderItem={({ item: row, index: rowIndex }) => (
        <View style={{ flexDirection: 'row', gap: cardGap, ...pad, marginBottom: rowGap }}>
          {row.map((item, column) => (
            <PosterCard
              key={itemKey(item)}
              ref={APPLE_TV && rowIndex === 0 && column === row.length - 1 ? setRowEnd : undefined}
              testID={`library-item-${rowIndex * columns + column}`}
              title={item.title ?? ''}
              subtitle={item.year ? String(item.year) : ''}
              imageUri={item.posterUrl}
              imageSizes={item.posterSizes}
              width={cardWidth}
              spec={item.spec}
              tint={item.tint}
              onFocus={() => {
                setZone('grid');
                showAmbient(item);
                liftRow(rowIndex);
                // TV focus walks the grid without scrolling events reaching the end first.
                if (rowIndex >= rows.length - PAGING_ROWS) loadMore();
              }}
              onHoverIn={() => showAmbient(item)}
              onPress={() => router.push(titleHref(item))}
            />
          ))}
          {/* Apple TV: Down from the sort pill over an empty stretch of the first row lands on its last poster. */}
          {APPLE_TV && rowIndex === 0 && rowEnd ? (
            <FocusGuide destinations={[rowEnd]} style={{ flex: 1, alignSelf: 'stretch' }} />
          ) : null}
        </View>
      )}
    />
  );
  // TV: the page scrolls only by the row lift; Down past the last row stays in the grid.
  if (design.isTV)
    return (
      <FocusGuide
        remember={false}
        trap={['down']}
        style={{ flex: 1 }}
        onLayout={(event) => setSize(event.nativeEvent.layout)}>
        {grid}
      </FocusGuide>
    );
  // iOS: the list is the screen's first view so UIKit adopts it (tab bar minimise, scroll-edge effect).
  return grid;
}

function ambientOf(item: CatalogItem) {
  const { tint, tint2, highlight } = item;
  return { image: item.backdropUrl ?? item.posterUrl, tint, tint2, highlight };
}

/** One glass pill with a segment per sort order in the title line; the selected one is filled. */
function SortControl({
  value,
  label,
  labelOf,
  onChange,
  onFocus,
  downTarget,
}: {
  value: LibrarySort;
  label: string;
  labelOf: (value: LibrarySort) => string;
  onChange: (value: LibrarySort) => void;
  onFocus: () => void;
  /** Android TV: Down goes to the selected genre chip (the geometric search skips the row to a poster). */
  downTarget: View | null;
}) {
  const design = useDesign();
  const compact = !useShell().large;
  const [selectedNode, setSelectedNode] = useState<View | null>(null);
  // The pressed segment remounts (keyed by state): hand TV focus to the new selection.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || !selectedNode) return;
    refocus.current = false;
    selectedNode.requestTVFocus?.();
  }, [selectedNode]);
  const height = design.layout.controlHeight.sm;
  const inset = design.space.xs;
  const segmentGap = useFocusGap(inset);
  const down = design.isTV && downTarget ? (findNodeHandle(downTarget) ?? undefined) : undefined;
  return (
    <Glass intensity="subtle" radius={(height + 2 * inset) / 2} style={{ padding: inset }}>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        destinations={selectedNode ? [selectedNode] : undefined}
        role="radiogroup"
        aria-label={label}
        testID="library-sort"
        style={{ flexDirection: 'row', gap: segmentGap }}>
        {LIBRARY_SORTS.map((option) => {
          const selected = option === value;
          return (
            // Keyed by state: Android keeps a stale square clip when only the fill of a rounded view changes.
            <Focusable
              key={`${option}-${selected ? 'on' : 'off'}`}
              testID={`library-sort-${option}`}
              ref={selected ? setSelectedNode : undefined}
              role="radio"
              aria-checked={selected}
              accessibilityLabel={labelOf(option)}
              onFocus={onFocus}
              nextFocusDown={down}
              onPress={() => {
                refocus.current = design.isTV && !selected;
                onChange(option);
              }}>
              <FocusLift kind="button" radius={height / 2}>
                <View
                  style={{
                    height,
                    borderRadius: height / 2,
                    paddingHorizontal: compact ? design.space.md : design.space.lg,
                    justifyContent: 'center',
                    backgroundColor: selected ? colors.primary.DEFAULT : undefined,
                  }}>
                  <Text
                    variant={compact ? 'caption' : 'callout'}
                    numberOfLines={1}
                    style={selected ? { color: colors.primary.foreground } : undefined}>
                    {labelOf(option)}
                  </Text>
                </View>
              </FocusLift>
            </Focusable>
          );
        })}
      </FocusGuide>
    </Glass>
  );
}
