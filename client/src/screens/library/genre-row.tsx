import { useRef, useState, type ReactNode, type Ref } from 'react';
import { ScrollView, View } from 'react-native';

import { END_OF_ROW, FocusGuide, useFocusGlowRoom } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { EdgeFade } from '@/components/ui/edge-fade';
import { gutters, useDesign } from '@/theme';

export type GenreChip = { id: number | null; name: string };

type Box = { x: number; width: number };

/** One single-line genre row: scrolls sideways, keeps the focused chip inside the gutters, fades where it continues. */
export function GenreRow({
  chips,
  selected,
  selectedRef,
  selectedNode,
  label,
  onSelect,
  onChipFocus,
  trailing,
}: {
  chips: readonly GenreChip[];
  selected: number | null;
  selectedRef: Ref<View>;
  selectedNode: View | null;
  label: string;
  onSelect: (id: number | null) => void;
  onChipFocus: () => void;
  /** Shown after the chips in the same line (Apple TV sort), reached by Right from the last chip. */
  trailing?: ReactNode;
}) {
  const design = useDesign();
  const { start, end: gutterEnd } = gutters(design);
  const end = trailing ? design.space.md : gutterEnd;
  const glow = useFocusGlowRoom();
  const scroll = useRef<ScrollView>(null);
  const boxes = useRef(new Map<string, Box>());
  const offset = useRef(0);
  const viewport = useRef(0);
  const content = useRef(0);
  const revealed = useRef<number | null | undefined>(undefined);
  const [edges, setEdges] = useState({ start: false, end: false });

  const updateEdges = () => {
    const next = {
      start: offset.current > 1,
      end: offset.current + viewport.current < content.current - 1,
    };
    setEdges((now) => (now.start === next.start && now.end === next.end ? now : next));
  };

  const selectedKey = String(selected ?? 'all');
  // A selected chip off screen (deep link, reload) scrolls into view once, as soon as both sizes are known.
  const revealSelected = () => {
    if (revealed.current === selected || !viewport.current || !boxes.current.has(selectedKey))
      return;
    revealed.current = selected;
    reveal(selectedKey, false);
  };

  const reveal = (key: string, animated: boolean) => {
    const box = boxes.current.get(key);
    const visible = viewport.current;
    if (!box || !visible) return;
    const right = box.x + box.width;
    if (right > offset.current + visible - end)
      scroll.current?.scrollTo({ x: right - visible + end, animated });
    else if (box.x < offset.current + start)
      scroll.current?.scrollTo({ x: Math.max(0, box.x - start), animated });
  };

  const row = (
    <EdgeFade
      start={edges.start ? start : 0}
      end={edges.end ? end : 0}
      style={{ marginVertical: -glow, flex: trailing ? 1 : undefined }}>
      <FocusGuide
        remember
        trap={trailing ? undefined : END_OF_ROW}
        destinations={selectedNode ? [selectedNode] : undefined}
        role="radiogroup"
        aria-label={label}
        testID="library-genres">
        <ScrollView
          ref={scroll}
          testID="library-genres-scroll"
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={100}
          onLayout={(event) => {
            viewport.current = event.nativeEvent.layout.width;
            updateEdges();
            revealSelected();
          }}
          onContentSizeChange={(width) => {
            content.current = width;
            updateEdges();
          }}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.x;
            updateEdges();
          }}
          contentContainerStyle={{
            paddingLeft: start,
            paddingRight: end,
            paddingVertical: glow,
            gap: design.space.sm,
          }}>
          {chips.map((chip) => {
            const key = String(chip.id ?? 'all');
            const isSelected = selected === chip.id;
            return (
              <View
                key={key}
                collapsable={false}
                onLayout={(event) => {
                  const { x, width } = event.nativeEvent.layout;
                  boxes.current.set(key, { x, width });
                  if (isSelected) revealSelected();
                }}>
                <GlassChip
                  testID={`library-genre-${key}`}
                  role="radio"
                  aria-checked={isSelected}
                  label={chip.name}
                  selected={isSelected}
                  ref={isSelected ? selectedRef : undefined}
                  onFocus={() => {
                    onChipFocus();
                    reveal(key, true);
                  }}
                  onPress={() => onSelect(chip.id)}
                />
              </View>
            );
          })}
        </ScrollView>
      </FocusGuide>
    </EdgeFade>
  );
  if (!trailing) return row;
  return (
    <View
      testID="library-genre-line"
      style={{ flexDirection: 'row', alignItems: 'center', paddingRight: gutterEnd }}>
      {row}
      {trailing}
    </View>
  );
}
