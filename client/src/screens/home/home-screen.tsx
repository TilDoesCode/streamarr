import { Film } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import {
  useContinueWatching,
  useHomeRows,
  useNextUp,
  type CatalogItem,
  type CatalogRow,
  useWatchRefreshOnFocus,
} from '@/browse/queries';
import { FocusGuide } from '@/components/focus';
import { Shelf } from '@/components/media/shelf';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { LandscapeCardSkeleton, PosterCardSkeleton } from '@/components/ui/skeleton';
import { useScreenTitle } from '@/navigation/screen-title';
import { BrandMark } from '@/shell/brand-mark';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, colors, gutterPadding, motion, useDesign } from '@/theme';

import { FeaturedStore, useFeatured, type Featured } from './featured';
import { ContinueCard, DiscoverCard, featuredFromItem, NextUpCard } from './home-cards';
import { HandheldHomeHero } from './home-hero';
import { ShellHero } from './shell-hero';

export { useHomeRows } from '@/browse/queries';

function isKeyboardFocus(event: unknown): boolean {
  const target = (event as { target?: { matches?: (selector: string) => boolean } })?.target;
  try {
    return target?.matches?.(':focus-visible') ?? false;
  } catch {
    return false;
  }
}

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
  useWatchRefreshOnFocus();
  const design = useDesign();
  const shell = useShell();
  const { s } = shell;
  const insets = useSafeAreaInsets();
  const { account } = useActiveAccount();
  const router = useRouter();
  const rows = useHomeRows();
  const resume = useContinueWatching();
  const nextUp = useNextUp();
  const [store] = useState(() => new FeaturedStore());
  useEffect(() => () => store.dispose(), [store]);
  // TV (Apple TV style): the focused row sits at a fixed height, the hero steps back below the first row.
  const [focusedRow, setFocusedRow] = useState(0);
  // Only the first visit takes focus; a card mounted later (reordered Continue watching) must not steal it.
  const [focusTaken, setFocusTaken] = useState(false);
  const [heroTarget, setHeroTarget] = useState<View | null>(null);
  const [inHero, setInHero] = useState(false);
  const rowFrames = useRef<{ y: number; height: number }[]>([]);
  const [framesVersion, setFramesVersion] = useState(0);
  const rowsRef = useRef<ScrollView>(null);
  const rowsOffset = useRef(0);
  const [scrolled, setScrolled] = useState(false);
  // Web keyboard focus below the first row: rows take the TV lift geometry (row at focusTop, hero copy hidden).
  const [raisedRow, setRaisedRow] = useState(0);
  const raised = raisedRow > 0;
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
  useEffect(() => {
    const frame = rowFrames.current[focusedRow];
    if (!frame) return;
    const target =
      focusedRow === 0
        ? Math.max(0, frame.y + frame.height - design.window.height)
        : frame.y - s(SHELL.row.focusTop);
    lift.set(withTiming(target, { duration: motion.enter }));
  }, [focusedRow, framesVersion, lift, s, design.window.height]);

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

  // Large shell: the hero follows the focused (TV) or hovered (web) card.
  const feature = shell.large
    ? (item: Parameters<FeaturedStore['set']>[0]) => store.set(item)
    : undefined;
  // Every form factor opens on the same featured title: the first Continue watching card, else the top pick.
  const lead = (item: Featured) => store.lead(item);
  const phoneHero = useFeatured(store) ?? topPick;
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
      itemKey: (index) => continueItems[index]?.workId ?? String(index),
      render: (index, preferred) => (
        <ContinueCard
          testID={`home-card-continue-${index}`}
          state={continueItems[index]!}
          width={landscapeWidth}
          eyebrow={continueTitle}
          onFeature={feature}
          onLead={preferred ? lead : undefined}
          hasTVPreferredFocus={preferred && !focusTaken}
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
          hasTVPreferredFocus={preferred && !focusTaken}
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
          hasTVPreferredFocus={preferred && !focusTaken}
        />
      ),
    });
  }

  const failed = [rows, resume, nextUp].filter((query) => query.error);
  const retryAll = () => {
    for (const query of [rows, resume, nextUp]) if (query.error) void query.refetch();
  };
  // Rows appear together: a late continue watching row would move focus under an early D-pad press.
  const pending = (query: { data: unknown; error: unknown }) =>
    query.data === undefined && !query.error;
  const loading = pending(rows) || pending(resume) || pending(nextUp);

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
      <HomeSkeleton posterWidth={posterWidth} landscapeWidth={landscapeWidth} />
    ) : (
      <>
        {failed.length ? (
          <View style={gutterPadding(design)}>
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
            const node = (
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
            if (!shell.large) return node;
            return (
              <View
                key={shelf.key}
                collapsable={false}
                style={{ opacity: shelfIndex < (design.isTV ? focusedRow : raisedRow) ? 0 : 1 }}
                onLayout={(event) => {
                  const { y, height } = event.nativeEvent.layout;
                  const known = rowFrames.current[shelfIndex];
                  if (known?.y === y && known.height === height) return;
                  rowFrames.current[shelfIndex] = { y, height };
                  setFramesVersion((version) => version + 1);
                }}
                onFocus={(event) => {
                  setFocusTaken(true);
                  if (design.isTV) setFocusedRow(shelfIndex);
                  else revealRow(shelfIndex, event);
                }}>
                {design.isTV && shelfIndex === 0 && heroTarget && !inHero ? (
                  // Up from the first row lands on the hero's first button; Down returns through the row memory.
                  <FocusGuide
                    remember={false}
                    destinations={[heroTarget]}
                    style={{ height: 2, marginBottom: -2 }}
                  />
                ) : null}
                {node}
              </View>
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

  if (shell.large && design.isTV)
    return (
      <View testID="home-screen" style={{ flex: 1, overflow: 'hidden' }}>
        <ShellHero
          store={store}
          collapsed={focusedRow > 0}
          targetRef={setHeroTarget}
          onButtonFocus={(focused) => {
            setInHero(focused);
            if (focused) setFocusedRow(0);
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
              top: 0,
              paddingTop: s(SHELL.row.top),
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
        <ShellHero store={store} collapsed={raised} />
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
              top: s(raised ? SHELL.row.focusTop : SHELL.row.top),
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

  return (
    <View testID="home-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          gap: design.layout.sectionGap,
        }}>
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
                <Avatar
                  name={account.displayName}
                  color={account.color}
                  size={design.px(34)}
                  round
                />
              </Pressable>
            </View>
          )}
        </View>
        {body}
      </ScrollView>
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
