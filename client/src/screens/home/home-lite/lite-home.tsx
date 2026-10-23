import { memo, useEffect, type ReactElement, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';

import { Shelf } from '@/components/media/shelf';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { aspect, gutterPadding, useDesign } from '@/theme';

import type { Featured, FeaturedStore } from '../featured';
import { LiteHero, LitePlayKey, TOP_SNAP } from './lite-hero';

/** One Home row as Home builds it (data and cards stay in home-screen). */
export type LiteShelfSpec = {
  key: string;
  title: string;
  kind: 'landscape' | 'poster';
  items: readonly unknown[];
  render: (index: number, preferred: boolean) => ReactElement;
  itemKey: (index: number) => string;
};

export type LiteHomeProps = {
  store: FeaturedStore;
  /** The hero's title before the store has one (the top pick). */
  topPick?: Featured;
  shelves: readonly LiteShelfSpec[];
  /** Bumped when Home is chosen again in the rail: rows remount on their first card. */
  generation: number;
  /** Memory key prefix of Home's rows (forgetShelves). */
  memoryPrefix: string;
  /** The first row's focus group (Home chosen again focuses it). */
  firstRowRef?: Ref<View>;
  /** A section failed to refresh: a notice with Retry above the rows. */
  failed?: unknown;
  onRetry: () => void;
  /** Error, skeleton or empty state instead of the rows. */
  fallback?: ReactNode;
  onRowFocus: () => void;
};

// Rows mounted ahead of the visible ones: one screen above and below is enough for D-pad moves.
const WINDOW = 3;

/** Lite Home (weak TV hardware): static banner, then a virtualized list of flat rows; nothing follows focus. */
export function LiteHome({
  store,
  topPick,
  shelves,
  generation,
  memoryPrefix,
  firstRowRef,
  failed,
  onRetry,
  fallback,
  onRowFocus,
}: LiteHomeProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  useEffect(() => {
    store.freeze(true);
    return () => store.freeze(false);
  }, [store]);
  const posterWidth = s(SHELL.poster.width);
  const landscapeWidth = s(SHELL.landscape.width);
  return (
    <View testID="home-screen" style={{ flex: 1 }}>
      <LitePlayKey store={store} fallback={topPick} />
      <FlatList
        testID="home-rows"
        data={fallback ? EMPTY : shelves}
        keyExtractor={(shelf) => `${generation}:${shelf.key}`}
        ListHeaderComponent={
          <>
            <LiteHero store={store} fallback={topPick} />
            {failed && !fallback ? (
              <View style={gutterPadding(design)}>
                <FormMessage
                  testID="home-refresh-error"
                  tone="warning"
                  title={describeError(t, toAppError(failed)).title}
                  actions={
                    <Button
                      testID="home-refresh-retry"
                      size="sm"
                      variant="secondary"
                      label={t('common.retry')}
                      onPress={onRetry}
                    />
                  }
                />
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={fallback ? <>{fallback}</> : null}
        renderItem={({ item, index }) => (
          <LiteRow
            shelf={item}
            index={index}
            memoryPrefix={memoryPrefix}
            guideRef={index === 0 ? firstRowRef : undefined}
            width={item.kind === 'poster' ? posterWidth : landscapeWidth}
            onRowFocus={onRowFocus}
          />
        )}
        initialNumToRender={WINDOW}
        maxToRenderPerBatch={2}
        windowSize={WINDOW}
        showsVerticalScrollIndicator={false}
        // TV: the focused row's title snaps under the top margin; the jump has no scroll animation.
        snapToAlignment="item"
        snapToItemPadding={s(48)}
        scrollAnimationEnabled={false}
        contentContainerStyle={{ paddingBottom: s(SHELL.height / 2), gap: s(20) }}
      />
    </View>
  );
}

const EMPTY: LiteShelfSpec[] = [];

type LiteRowProps = {
  shelf: LiteShelfSpec;
  index: number;
  width: number;
  memoryPrefix: string;
  guideRef?: Ref<View>;
  onRowFocus: () => void;
};

/** One flat row; the first scrolls the page to its top so the banner stays above it. */
const LiteRow = memo(function LiteRow({
  shelf,
  index,
  width,
  memoryPrefix,
  guideRef,
  onRowFocus,
}: LiteRowProps) {
  return (
    <View
      collapsable={false}
      scrollSnapOffset={index === 0 ? TOP_SNAP : undefined}
      onFocus={onRowFocus}>
      <Shelf
        testID={`home-row-${shelf.key}`}
        memoryKey={`${memoryPrefix}${shelf.key}`}
        guideRef={guideRef}
        title={shelf.title}
        data={shelf.items}
        keyExtractor={(_, item) => shelf.itemKey(item)}
        itemWidth={width}
        artworkHeight={width / (shelf.kind === 'poster' ? aspect.poster : aspect.landscape)}
        renderItem={({ index: item }) => shelf.render(item, index === 0 && item === 0)}
      />
    </View>
  );
});
