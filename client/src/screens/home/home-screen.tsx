import { Film } from '@/components/icons';
import { memo, useEffect, useRef, useState, type ReactElement, type Ref } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { FocusGuide } from '@/components/focus';
import { StatusBarScrim, useStatusBarScrimHeight } from '@/components/media/scrim';
import { forgetShelves, Shelf } from '@/components/media/shelf';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { LandscapeCardSkeleton, PosterCardSkeleton } from '@/components/ui/skeleton';
import { useScreenTitle } from '@/navigation/screen-title';
import { useLiteMode } from '@/performance';
import { focusUntilMoved, usePreferredFocus, useScreenTop } from '@/navigation/screen-focus';
import { BrandMark } from '@/shell/brand-mark';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, colors, gutterPadding, motion, useDesign } from '@/theme';

import { continueRowKeys, FeaturedStore, useFeatured, type Featured } from './featured';
import {
  ContinueCard,
  DiscoverCard,
  featuredFromItem,
  featuredKey,
  NextUpCard,
} from './home-cards';
import { useHomeData } from './home-data';
import { HandheldHomeHero } from './home-hero';
import { LiteHome } from './home-lite/lite-home';
import { useLaunchFocus } from './launch-focus';
import { heroRowsTop, ShellHero } from './shell-hero';

export { useHomeRows } from '@/browse/queries';

// UIKit's focus engine skips fully transparent views; a near-zero alpha keeps rows above reachable on tvOS.
const HIDDEN_ROW = Platform.OS === 'ios' ? 0.02 : 0;

function isKeyboardFocus(event: unknown): boolean {
  const target = (event as { target?: { matches?: (selector: string) => boolean } })?.target;
  try {
    return target?.matches?.(':focus-visible') ?? false;
  } catch {
    return false;
  }
}

// Shelf memory keys of Home's rows.
const HOME_SHELF = 'home-';

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
  useScreenTitle(t('tabs.home'));
  const design = useDesign();
  const shell = useShell();
  const { s } = shell;
  const insets = useSafeAreaInsets();
  const scrimHeight = useStatusBarScrimHeight();
  // Weak TV hardware: the lean layout (home-lite) with the same rows and cards.
  const liteTV = useLiteMode() && shell.large && design.isTV;
  const [store] = useState(() => new FeaturedStore());
  useEffect(() => () => store.dispose(), [store]);
  // TV (Apple TV style): the focused row sits at a fixed height, the hero steps back below the first row.
  // A shared value: a D-pad move between rows must not re-render Home and its cards.
  const focusedRow = useSharedValue(0);
  const [collapsed, setCollapsed] = useState(false);
  // Only the first visit takes focus; a card mounted later (reordered Continue watching) must not steal it.
  const [focusTaken, setFocusTaken] = useState(false);
  // Apple TV starts on the hero's main button (useLaunchFocus); Android TV on the first card.
  const cardFocus = !focusTaken && !(Platform.OS === 'ios' && Platform.isTV);
  const [heroTarget, setHeroTarget] = useState<View | null>(null);
  const [inHero, setInHero] = useState(false);
  const rowFrames = useRef<{ y: number; height: number }[]>([]);
  const frames = useSharedValue<{ y: number; height: number }[]>([]);
  const rowsRef = useRef<ScrollView>(null);
  const rowsOffset = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  // Web keyboard focus below the first row: rows take the TV lift geometry (row at focusTop, hero copy hidden).
  const [raisedRow, setRaisedRow] = useState(0);
  const raised = raisedRow > 0;
  const [copyBottom, setCopyBottom] = useState(0);
  const revealRow = (index: number, event: unknown) => {
    if (!isKeyboardFocus(event)) return;
    const frame = rowFrames.current[index];
    if (!frame) return;
    setRaisedRow(index);
    const y = index > 0 ? frame.y : 0;
    if (Math.abs(y - rowsOffset.current) > 1) rowsRef.current?.scrollTo({ y, animated: true });
  };
  const lift = useSharedValue(0);
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.get() }] }));
  const tvRowsTop = heroRowsTop(s, copyBottom, shell.heroFrame.rowsTop);
  // Row 0 rises to fit the screen, but never into the hero copy (a tall poster row would cover the buttons).
  const firstRowRoom = Math.max(0, tvRowsTop - copyBottom - s(SHELL.row.gap));
  const focusTop = s(SHELL.row.focusTop);
  const windowHeight = design.window.height;
  useAnimatedReaction(
    () => {
      const row = focusedRow.get();
      const frame = frames.get()[row];
      if (!frame) return null;
      const y = tvRowsTop + frame.y;
      return row === 0
        ? Math.min(firstRowRoom, Math.max(0, y + frame.height - windowHeight))
        : y - focusTop;
    },
    (target, previous) => {
      if (target !== null && target !== previous)
        lift.set(withTiming(target, { duration: motion.enter }));
    },
    [tvRowsTop, firstRowRoom, focusTop, windowHeight]
  );
  const focusRow = (index: number) => {
    focusedRow.set(index);
    setCollapsed(index > 0);
  };

  // TV: Home chosen again in the rail starts over like a launch: fresh rows on their first card, focus on the first row.
  const [generation, setGeneration] = useState(0);
  const firstRow = useRef<View | null>(null);
  const rowFocusReports = useRef(0);
  const topFocus = useRef(false);
  useScreenTop(() => {
    forgetShelves(HOME_SHELF);
    focusRow(0);
    setFocusTaken(false);
    topFocus.current = true;
    setGeneration((value) => value + 1);
  });
  useEffect(() => {
    if (!topFocus.current) return;
    topFocus.current = false;
    return focusUntilMoved(
      () => firstRow.current,
      () => rowFocusReports.current
    );
  }, [generation]);

  // One gate for the whole page: the first visible Home is the final one (rows, hero, focus).
  const home = useHomeData({ epoch: generation });
  const { discover, continueItems, nextItems } = home;
  const loading = !home.ready;
  const firstItem = discover[0]?.items[0];
  const firstRowTitle = discover[0] ? t(`home.rows.${rowKey(discover[0].id)}`) : '';
  // The top pick only leads without a Continue / Next up card: those feature themselves (onLead).
  const personal = continueItems.length > 0 || nextItems.length > 0;
  const topPick =
    !loading && !personal && firstItem ? featuredFromItem(firstItem, firstRowTitle) : undefined;
  useEffect(() => store.initial(topPick), [store, topPick]);

  // Large shell: the hero follows the focused (TV) or hovered (web) card.
  const feature = shell.large
    ? (item: Parameters<FeaturedStore['set']>[0]) => store.set(item)
    : undefined;
  const continueKeys = continueRowKeys(continueItems.map((item) => item.workId));
  const cardKeys = [
    ...continueItems.map((item) => featuredKey.continue(item.workId)),
    ...nextItems.map((item) => featuredKey.next(item.workId)),
    ...discover.flatMap((row) =>
      row.items.map((item) => featuredKey.item(item.mediaType, item.tmdbId))
    ),
  ].join('|');
  useEffect(() => store.present(new Set(cardKeys.split('|'))), [store, cardKeys]);
  // Every form factor opens on the same featured title: the first Continue watching card, else the top pick.
  const lead = (item: Featured) => store.lead(item);
  const posterWidth = shell.large ? s(SHELL.poster.width) : design.layout.posterWidth;
  const landscapeWidth = shell.large ? s(SHELL.landscape.width) : design.layout.landscapeWidth;
  const continueTitle = t('home.continueWatching');
  const nextTitle = t('home.nextUp');

  const shelves: ShelfSpec[] = [];
  if (continueItems.length)
    shelves.push({
      key: 'continue',
      title: continueTitle,
      kind: 'landscape',
      items: continueItems,
      itemKey: (index) => continueKeys[index] ?? String(index),
      render: (index, preferred) => (
        <ContinueCard
          testID={`home-card-continue-${index}`}
          state={continueItems[index]!}
          width={landscapeWidth}
          eyebrow={continueTitle}
          onFeature={feature}
          onLead={preferred ? lead : undefined}
          hasTVPreferredFocus={cardFocus && preferred}
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
          onLead={preferred ? lead : undefined}
          hasTVPreferredFocus={cardFocus && preferred}
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
          hasTVPreferredFocus={cardFocus && preferred}
        />
      ),
    });
  }

  const failed = home.failed;
  const retryAll = home.retry;
  useLaunchFocus(heroTarget, !focusTaken && !loading);
  // Apple TV: a played card that left Home (finished, dropped out of Continue) hands its return to the hero (F12).
  usePreferredFocus(heroTarget);

  const onRowFocus = (index: number, event: unknown) => {
    rowFocusReports.current += 1;
    setFocusTaken(true);
    if (design.isTV) focusRow(index);
    else revealRow(index, event);
  };
  const onRowLayout = (index: number, y: number, height: number) => {
    const known = rowFrames.current[index];
    if (known?.y === y && known.height === height) return;
    rowFrames.current[index] = { y, height };
    frames.set([...rowFrames.current]);
  };

  const body = home.rowsError ? (
    <ErrorState
      testID="home-error"
      code={toAppError(home.rowsError).code}
      actions={['retry']}
      autoFocus
      onAction={retryAll}
    />
  ) : loading ? (
    <HomeSkeleton posterWidth={posterWidth} landscapeWidth={landscapeWidth} />
  ) : (
    <>
      {failed.length ? (
        <View style={gutterPadding(design)}>
          <FormMessage
            testID="home-refresh-error"
            tone="warning"
            title={describeError(t, toAppError(failed[0])).title}
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
        shelves.map((shelf, shelfIndex) => (
          <HomeRow
            key={`${generation}:${shelf.key}`}
            shelf={shelf}
            index={shelfIndex}
            guideRef={shelfIndex === 0 ? firstRow : undefined}
            width={shelf.kind === 'poster' ? posterWidth : landscapeWidth}
            large={shell.large}
            isTV={design.isTV}
            focusedRow={focusedRow}
            raisedRow={design.isTV ? 0 : raisedRow}
            heroTarget={
              design.isTV && shelfIndex === 0 && heroTarget && !inHero ? heroTarget : null
            }
            onRowFocus={onRowFocus}
            onRowLayout={onRowLayout}
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

  if (liteTV)
    return (
      <LiteHome
        store={store}
        topPick={topPick}
        shelves={shelves}
        generation={generation}
        memoryPrefix={HOME_SHELF}
        firstRowRef={firstRow}
        failed={failed[0]}
        onRetry={retryAll}
        fallback={loading || home.rowsError || !shelves.length ? body : null}
        onRowFocus={() => {
          rowFocusReports.current += 1;
          setFocusTaken(true);
        }}
      />
    );

  if (shell.large && design.isTV)
    return (
      <View testID="home-screen" style={{ flex: 1, overflow: 'hidden' }}>
        <ShellHero
          store={store}
          collapsed={collapsed}
          targetRef={setHeroTarget}
          onCopyBottom={setCopyBottom}
          onButtonFocus={(focused) => {
            setInHero(focused);
            if (focused) focusRow(0);
          }}
        />
        <Animated.View
          testID="home-rows"
          style={[
            {
              pointerEvents: 'box-none',
              position: 'absolute',
              left: 0,
              right: 0,
              // Below the hero copy, not over it: tvOS does not focus views covered by another view.
              top: tvRowsTop,
              paddingBottom: s(SHELL.height / 2),
              gap: s(8),
            },
            liftStyle,
          ]}>
          {body}
        </Animated.View>
      </View>
    );

  if (shell.large)
    return (
      <View testID="home-screen" style={{ flex: 1 }}>
        <ShellHero store={store} collapsed={raised} onCopyBottom={setCopyBottom} />
        <ScrollView
          ref={rowsRef}
          onScroll={(event) => {
            rowsOffset.current = event.nativeEvent.contentOffset.y;
            if (rowsOffset.current <= 0) setRaisedRow(0);
            setScrolled(rowsOffset.current > 1);
          }}
          scrollEventThrottle={100}
          testID="home-rows"
          style={[
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: raised
                ? s(SHELL.row.focusTop)
                : heroRowsTop(s, copyBottom, shell.heroFrame.rowsTop),
            },
            scrolled && topFade(s(56)),
          ]}
          // D-pad presses during the skeleton must not scroll away from the first row.
          scrollEnabled={!loading}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: s(SHELL.height / 2), gap: s(8) }}>
          {body}
        </ScrollView>
      </View>
    );

  // iOS: the ScrollView is the screen's first view so UIKit adopts it (tab bar minimise); a wrapper breaks that.
  const statusScrim = Platform.OS !== 'web';
  return (
    <ScrollView
      testID="home-screen"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="never"
      stickyHeaderIndices={statusScrim ? [0] : undefined}
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        gap: design.layout.sectionGap,
      }}>
      {statusScrim ? (
        // A real height: Android clips a zero-height sticky header; the negative margin takes no layout room.
        <View
          testID="home-status-scrim"
          // In style, not a prop: the sticky header wrapper takes the style, and it covers the avatar.
          style={{
            pointerEvents: 'none',
            height: scrimHeight,
            marginBottom: -scrimHeight - design.layout.sectionGap,
            zIndex: 1,
          }}>
          <StatusBarScrim />
        </View>
      ) : null}
      <HandheldTop store={store} topPick={topPick} loading={loading} />
      {body}
    </ScrollView>
  );
}

type HomeRowProps = {
  shelf: ShelfSpec;
  index: number;
  width: number;
  large: boolean;
  isTV: boolean;
  focusedRow: SharedValue<number>;
  /** Web keyboard focus: rows above the raised one hide. */
  raisedRow: number;
  /** TV, first row: Up lands on the hero's first button. */
  heroTarget: View | null;
  /** The first row's focus group (TV: Home chosen again focuses it). */
  guideRef?: Ref<View>;
  onRowFocus: (index: number, event: unknown) => void;
  onRowLayout: (index: number, y: number, height: number) => void;
};

/** One Home shelf; memoised so focus moving between rows re-renders no cards. */
const HomeRow = memo(function HomeRow({
  shelf,
  index,
  width,
  large,
  isTV,
  focusedRow,
  raisedRow,
  heroTarget,
  guideRef,
  onRowFocus,
  onRowLayout,
}: HomeRowProps) {
  const hiddenStyle = useAnimatedStyle(
    () => ({ opacity: (isTV ? focusedRow.get() : raisedRow) > index ? HIDDEN_ROW : 1 }),
    [isTV, raisedRow, index]
  );
  const node = (
    <Shelf
      testID={`home-row-${shelf.key}`}
      memoryKey={`${HOME_SHELF}${shelf.key}`}
      guideRef={guideRef}
      title={shelf.title}
      data={shelf.items}
      keyExtractor={(_, item) => shelf.itemKey(item)}
      itemWidth={width}
      artworkHeight={width / (shelf.kind === 'poster' ? aspect.poster : aspect.landscape)}
      renderItem={({ index: item }) => shelf.render(item, index === 0 && item === 0)}
    />
  );
  if (!large) return node;
  return (
    <Animated.View
      collapsable={false}
      style={hiddenStyle}
      onLayout={(event) => {
        const { y, height } = event.nativeEvent.layout;
        onRowLayout(index, y, height);
      }}
      onFocus={(event) => onRowFocus(index, event)}>
      {heroTarget ? (
        // Up from the first row lands on the hero's first button; Down returns through the row memory.
        <FocusGuide
          remember={false}
          destinations={[heroTarget]}
          style={{ height: 2, marginBottom: -2 }}
        />
      ) : null}
      {node}
    </Animated.View>
  );
});

/** Phone and tablet: the featured hero with the brand and profile bar; subscribes to the hero on its own. */
function HandheldTop({
  store,
  topPick,
  loading,
}: {
  store: FeaturedStore;
  topPick: Featured | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { account } = useActiveAccount();
  const phoneHero = useFeatured(store) ?? topPick;
  return (
    <View>
      {phoneHero ? (
        <HandheldHomeHero featured={phoneHero} />
      ) : loading ? (
        <View style={{ height: design.layout.heroHeight }} />
      ) : null}
      {Platform.OS === 'web' ? null : (
        <View
          style={{
            position: phoneHero || loading ? 'absolute' : 'relative',
            top: insets.top + design.space.sm,
            left: 0,
            right: 0,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: design.layout.gutter,
            paddingTop: phoneHero || loading ? 0 : insets.top + design.space.sm,
          }}>
          <BrandMark size={design.px(32)} />
          <Pressable
            testID="home-profile"
            role="button"
            accessibilityLabel={t('settings.account.switchNamed', {
              name: account.displayName,
            })}
            onPress={() => router.push('/profiles')}
            hitSlop={design.space.sm}>
            <Avatar name={account.displayName} color={account.color} size={design.px(34)} round />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function HomeSkeleton({
  posterWidth,
  landscapeWidth,
}: {
  posterWidth: number;
  landscapeWidth: number;
}) {
  const design = useDesign();
  return (
    <View testID="home-loading" style={{ gap: design.layout.sectionGap }}>
      {(['landscape', 'poster'] as const).map((kind) => (
        <View
          key={kind}
          style={{
            flexDirection: 'row',
            gap: design.layout.cardGap,
            ...gutterPadding(design),
            overflow: 'hidden',
          }}>
          {Array.from({ length: 8 }, (_, index) =>
            kind === 'poster' ? (
              <PosterCardSkeleton key={index} width={posterWidth} />
            ) : (
              <LandscapeCardSkeleton key={index} width={landscapeWidth} />
            )
          )}
        </View>
      ))}
    </View>
  );
}

// Web: rows scrolled by the wheel fade out under the hero instead of leaving a cut caption line.
function topFade(size: number): ViewStyle | undefined {
  if (Platform.OS !== 'web') return undefined;
  const mask = `linear-gradient(to bottom, transparent 0, black ${size}px)`;
  return { maskImage: mask, WebkitMaskImage: mask } as unknown as ViewStyle;
}
