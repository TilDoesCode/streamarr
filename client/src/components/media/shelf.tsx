import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Platform, View, type ListRenderItemInfo } from 'react-native';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { useFocusRoom } from '@/components/media/card-parts';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

// TV: last focused index per shelf `memoryKey`; survives the shelf unmounting (tab switch, refetch).
const shelfMemory = new Map<string, number>();

export type ShelfProps<T> = {
  title: string;
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: { item: T; index: number }) => ReactElement;
  /** Width of one item (all items share it), e.g. layout.posterWidth. */
  itemWidth: number;
  /** Height of the item's artwork, to reserve room for the focus lift. */
  artworkHeight: number;
  /** Stable id to restore the focused item (TV) after the shelf remounts. */
  memoryKey?: string;
  /** Header accessory (e.g. "See all"); not rendered on TV, where it would break row-to-row focus. */
  action?: ReactNode;
  testID?: string;
};

/** Horizontal row; on TV a focus group that remembers its item, snaps it to the gutter, keeps the ends. */
export function Shelf<T>({
  title,
  data,
  keyExtractor,
  renderItem,
  itemWidth,
  artworkHeight,
  memoryKey,
  action,
  testID,
}: ShelfProps<T>) {
  const { t } = useTranslation();
  const design = useDesign();
  const { gutter, cardGap } = design.layout;
  const focusRoom = useFocusRoom(artworkHeight);
  const listRef = useRef<FlatList<T>>(null);
  const offset = useRef(0);
  const stride = itemWidth + cardGap;
  // Fixed at mount: a remembered item renders first and starts at the gutter (contentOffset).
  const [restore] = useState(() => {
    const index =
      design.isTV && memoryKey ? clampIndex(shelfMemory.get(memoryKey), data.length) : undefined;
    return index ? { index, offset: { x: index * stride, y: 0 } } : undefined;
  });
  const restoreIndex = restore?.index;
  const [restoreTarget, setRestoreTarget] = useState<View | null>(null);
  const [restoring, setRestoring] = useState(restore !== undefined);
  const pager = design.formFactor === 'desktop-web';

  const page = (direction: 1 | -1) => {
    const pageWidth = Math.max(itemWidth, design.window.width - gutter * 2);
    const next = Math.max(0, offset.current + direction * pageWidth);
    listRef.current?.scrollToOffset({ offset: next, animated: true });
  };

  const renderCell = ({ item, index }: ListRenderItemInfo<T>) => (
    <View
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'start' : undefined}
      ref={index === restoreIndex ? setRestoreTarget : undefined}
      onFocus={() => {
        if (memoryKey && design.isTV) shelfMemory.set(memoryKey, index);
      }}>
      {renderItem({ item, index })}
    </View>
  );

  return (
    <View testID={testID} collapsable={false} scrollSnapAlign={design.isTV ? 'start' : undefined}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: gutter,
          gap: design.space.lg,
        }}>
        <Text variant="heading" numberOfLines={1} style={{ flexShrink: 1 }}>
          {title}
        </Text>
        {!design.isTV && (action || pager) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
            {action}
            {pager ? (
              <>
                <IconButton
                  icon={ChevronLeft}
                  size="sm"
                  variant="ghost"
                  accessibilityLabel={t('a11y.scrollBack')}
                  onPress={() => page(-1)}
                />
                <IconButton
                  icon={ChevronRight}
                  size="sm"
                  variant="ghost"
                  accessibilityLabel={t('a11y.scrollForward')}
                  onPress={() => page(1)}
                />
              </>
            ) : null}
          </View>
        ) : null}
      </View>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        destinations={restoring && restoreTarget ? [restoreTarget] : EMPTY}
        onFocusEnter={() => setRestoring(false)}>
        <FlatList
          ref={listRef}
          horizontal
          data={data}
          keyExtractor={keyExtractor}
          renderItem={renderCell}
          showsHorizontalScrollIndicator={false}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.x;
          }}
          scrollEventThrottle={100}
          contentContainerStyle={{
            paddingHorizontal: gutter,
            paddingVertical: focusRoom,
            gap: cardGap,
          }}
          getItemLayout={(_, index) => ({ length: stride, offset: gutter + index * stride, index })}
          initialScrollIndex={restoreIndex}
          contentOffset={restore?.offset}
          initialNumToRender={design.isTV ? 12 : 6}
          windowSize={design.isTV ? 9 : 5}
          removeClippedSubviews={false}
          snapToAlignment={design.isTV ? 'item' : undefined}
          snapToItemPadding={design.isTV ? gutter : undefined}
          snapToInterval={Platform.OS !== 'web' && !design.isTV ? stride : undefined}
          decelerationRate={Platform.OS !== 'web' && !design.isTV ? 'fast' : undefined}
        />
      </FocusGuide>
    </View>
  );
}

const EMPTY: View[] = [];

function clampIndex(index: number | undefined, length: number) {
  if (index === undefined || length === 0) return undefined;
  return Math.min(Math.max(0, index), length - 1);
}
