import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react-native';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Platform, View, type ListRenderItemInfo } from 'react-native';

import {
  END_OF_ROW,
  FocusGuide,
  Focusable,
  FocusLift,
  useFocusGlowRoom,
  type FocusableProps,
} from '@/components/focus';
import { Glass } from '@/components/glass';
import { useFocusRoom } from '@/components/media/card-parts';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { Text } from '@/components/ui/text';
import { colors, fonts, gutters, useDesign } from '@/theme';

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
  const shell = useShell();
  const { start: gutter, end: gutterEnd } = gutters(design);
  const cardGap = shell.large ? shell.s(SHELL.row.gap) : design.layout.cardGap;
  const focusRoom = useFocusRoom(artworkHeight);
  // The tinted glow reaches past the ring: extra room inside the viewport, pulled back by a negative margin.
  const glowRoom = Math.max(
    0,
    useFocusGlowRoom() - design.focus.ringOffset - design.focus.ringWidth - design.px(4)
  );
  const headerGap = shell.large ? shell.s(SHELL.row.headerGap) : 0;
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
  const pager = Platform.OS === 'web' && shell.large;
  const viewport = useRef(0);
  const [edges, setEdges] = useState({ start: true, end: false });
  const contentWidth = gutter + gutterEnd + data.length * stride - cardGap;

  const page = (direction: 1 | -1) => {
    const pageWidth = Math.max(
      itemWidth,
      Math.floor((viewport.current - gutter - gutterEnd + cardGap) / stride) * stride
    );
    const next = Math.max(0, offset.current + direction * pageWidth);
    listRef.current?.scrollToOffset({ offset: next, animated: true });
  };

  // Web keyboard focus: scroll a partly hidden card fully into the row (pointer hover never scrolls).
  const revealItem = (index: number) => {
    const start = gutter + index * stride;
    const end = start + itemWidth;
    const visible = viewport.current;
    if (!visible) return;
    if (end > offset.current + visible - gutterEnd)
      listRef.current?.scrollToOffset({ offset: end - visible + gutterEnd, animated: true });
    else if (start < offset.current + gutter)
      listRef.current?.scrollToOffset({ offset: Math.max(0, start - gutter), animated: true });
  };

  // Gaps are cell margins, not `gap`: a container gap would also follow VirtualizedList's spacers.
  const renderCell = ({ item, index }: ListRenderItemInfo<T>) => (
    <View
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'start' : undefined}
      style={{ marginRight: index < data.length - 1 ? cardGap : 0 }}
      ref={index === restoreIndex ? setRestoreTarget : undefined}
      onFocus={() => {
        if (memoryKey && design.isTV) shelfMemory.set(memoryKey, index);
        if (Platform.OS === 'web') revealItem(index);
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
          paddingLeft: gutter,
          paddingRight: gutterEnd,
          gap: design.space.lg,
          minHeight: shell.large ? shell.s(SHELL.row.header) : undefined,
          // The focus room already spaces the cards; the header keeps the mockup's 16 pt.
          marginBottom: shell.large && !design.isTV ? Math.min(0, headerGap - focusRoom) : 0,
          zIndex: 1,
        }}>
        <Text
          variant="heading"
          numberOfLines={1}
          role="heading"
          style={[
            { flexShrink: 1 },
            shell.large && {
              fontFamily: fonts.display,
              fontSize: shell.s(SHELL.type.rowTitle),
              lineHeight: shell.s(SHELL.row.header),
              letterSpacing: -shell.s(0.4),
            },
          ]}>
          {title}
        </Text>
        {!design.isTV && (action || pager) ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
            {action}
            {pager ? (
              <>
                <ShellArrow
                  icon={ChevronLeft}
                  lit={!edges.start}
                  accessibilityLabel={t('a11y.scrollBack')}
                  onPress={() => page(-1)}
                />
                <ShellArrow
                  icon={ChevronRight}
                  lit={!edges.end}
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
          onLayout={(event) => {
            viewport.current = event.nativeEvent.layout.width;
            if (pager)
              setEdges({
                start: offset.current <= 1,
                end: offset.current + viewport.current >= contentWidth - 1,
              });
          }}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.x;
            if (!pager) return;
            const next = {
              start: offset.current <= 1,
              end: offset.current + viewport.current >= contentWidth - 1,
            };
            setEdges((current) =>
              current.start === next.start && current.end === next.end ? current : next
            );
          }}
          scrollEventThrottle={100}
          style={{ marginVertical: -glowRoom }}
          contentContainerStyle={{
            paddingLeft: gutter,
            paddingRight: gutterEnd,
            paddingVertical: focusRoom + glowRoom,
          }}
          getItemLayout={(_, index) => ({
            length: index < data.length - 1 ? stride : itemWidth,
            offset: gutter + index * stride,
            index,
          })}
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

/** Web row pager arrow: a glass disc, dimmed at the row's end. */
function ShellArrow({
  icon: Icon,
  lit,
  ...props
}: Omit<FocusableProps, 'children'> & { icon: LucideIcon; lit: boolean }) {
  const { s } = useShell();
  const size = s(SHELL.row.arrow);
  return (
    // Mouse-only pager: keyboard users move through the cards themselves.
    <Focusable role="button" focusable={false} {...props}>
      <FocusLift kind="button" radius={size / 2}>
        <Glass interactive intensity={lit ? 'strong' : 'subtle'} radius={size / 2}>
          <View
            style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Icon
              size={s(24)}
              color={lit ? colors.foreground.DEFAULT : colors.foreground.subtle}
              strokeWidth={2.25}
            />
          </View>
        </Glass>
      </FocusLift>
    </Focusable>
  );
}
