import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import type { SeriesDetail } from '@/browse/queries';
import { seasonName } from '@/browse/season-name';
import { orderedSeasons } from '@/browse/series-selection';
import { END_OF_ROW, FocusGuide, useFocusGlowRoom } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { EdgeFade, type EdgeFadeProps } from '@/components/ui/edge-fade';
import { Text } from '@/components/ui/text';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, useFocusGap } from '@/theme';

type Box = { x: number; width: number };

// Android: MaskedView rasterises its mask on the CPU (4K TV boxes), so a cut chip dims instead of fading out.
const MASK_FADE = Platform.OS !== 'android';
const CUT_OPACITY = 0.35;

/** Seasons whose chip the row's edge cuts (window: scroll offset + viewport width); the focused one never dims. */
export function cutSeasons(
  boxes: ReadonlyMap<number, Box>,
  offset: number,
  viewport: number,
  focused?: number
): number[] {
  if (!viewport) return [];
  return [...boxes]
    .filter(
      ([n, box]) =>
        n !== focused && (box.x < offset - 1 || box.x + box.width > offset + viewport + 1)
    )
    .map(([n]) => n);
}

/** Season chips of the series Bühne (specials last); Select/tap switches the season, focus alone never does. */
export function SeasonChips({
  seasons,
  season,
  tint,
  position,
  onSeason,
  onFocusInside,
}: {
  seasons: SeriesDetail['seasons'];
  season: number;
  tint?: string | null;
  /** "Episode 2 of 3" on the right. */
  position?: string;
  onSeason: (season: number) => void;
  /** TV: focus entered (true) or left (false) the chips. */
  onFocusInside?: (inside: boolean) => void;
}) {
  const { t } = useTranslation();
  const { s, font } = useShell();
  const gap = useFocusGap(s(16));
  // The row scrolls (many seasons); this room keeps the focused chip's ring and glow inside it.
  const glow = useFocusGlowRoom();
  // A chip cut at the row's end fades out instead of ending hard beside the episode position.
  const fade = Math.max(glow, s(48));
  const [edges, setEdges] = useState({ start: false, end: false });
  const [cut, setCut] = useState<readonly number[]>([]);
  // TV: entering the chips from above lands on the active season, not the geometrically nearest chip.
  const [activeNode, setActiveNode] = useState<View | null>(null);
  const scroll = useRef<ScrollView>(null);
  const boxes = useRef(new Map<number, Box>());
  const offset = useRef(0);
  const viewport = useRef(0);
  const content = useRef(0);
  // The season whose row the viewer moved themselves (focus, drag): no automatic scroll fights them.
  const taken = useRef<number | undefined>(undefined);
  const focused = useRef<number | undefined>(undefined);

  const updateEdges = () => {
    const next = {
      start: offset.current > 1,
      end: offset.current + viewport.current < content.current - 1,
    };
    setEdges((now) => (now.start === next.start && now.end === next.end ? now : next));
    if (MASK_FADE) return;
    const dim = cutSeasons(boxes.current, offset.current, viewport.current, focused.current);
    setCut((now) => (now.join() === dim.join() ? now : dim));
  };

  const reveal = (seasonNumber: number, animated: boolean) => {
    const box = boxes.current.get(seasonNumber);
    const visible = viewport.current;
    if (!box || !visible) return;
    const right = box.x + box.width + fade;
    if (right > offset.current + visible)
      scroll.current?.scrollTo({ x: right - visible, animated });
    else if (box.x - fade < offset.current)
      scroll.current?.scrollTo({ x: Math.max(0, box.x - fade), animated });
  };
  // The active season (deep link, last chip of a long series) stays visible while the sizes settle (fonts, data).
  const revealActive = () => {
    if (taken.current === season) return;
    reveal(season, false);
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(40) + glow }}>
      <RowEdge
        start={edges.start ? fade : 0}
        end={edges.end ? fade : 0}
        style={{ flexShrink: 1, margin: -glow }}>
        <FocusGuide
          // tvOS ignores destinations once the guide remembers a child: enter on the active season every time.
          remember={!activeNode}
          trap={END_OF_ROW}
          testID="series-seasons"
          destinations={activeNode ? [activeNode] : undefined}
          onFocusEnter={() => onFocusInside?.(true)}
          onFocusLeave={() => {
            focused.current = undefined;
            updateEdges();
            onFocusInside?.(false);
          }}>
          <ScrollView
            ref={scroll}
            testID="series-seasons-scroll"
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={100}
            onLayout={(event) => {
              viewport.current = event.nativeEvent.layout.width;
              updateEdges();
              revealActive();
            }}
            onContentSizeChange={(width) => {
              content.current = width;
              updateEdges();
              revealActive();
            }}
            onScrollBeginDrag={() => {
              taken.current = season;
            }}
            onScroll={(event) => {
              offset.current = event.nativeEvent.contentOffset.x;
              updateEdges();
            }}
            contentContainerStyle={{ padding: glow, gap }}>
            {orderedSeasons(seasons).map((item) => (
              <View
                key={item.seasonNumber}
                collapsable={false}
                style={cut.includes(item.seasonNumber) ? { opacity: CUT_OPACITY } : undefined}
                onLayout={(event) => {
                  const { x, width } = event.nativeEvent.layout;
                  boxes.current.set(item.seasonNumber, { x, width });
                  updateEdges();
                  if (item.seasonNumber === season) revealActive();
                }}>
                <GlassChip
                  testID={`season-${item.seasonNumber}`}
                  tint={tint}
                  label={
                    item.seasonNumber === 0
                      ? item.title?.trim() || t('media.specials')
                      : t('detail.seasonTag', {
                          title: seasonName(t, item.title, item.seasonNumber),
                          played: item.playedCount ?? 0,
                          total: item.episodeCount ?? 0,
                        })
                  }
                  selected={item.seasonNumber === season}
                  ref={item.seasonNumber === season ? setActiveNode : undefined}
                  onFocus={() => {
                    taken.current = season;
                    focused.current = item.seasonNumber;
                    updateEdges();
                    reveal(item.seasonNumber, true);
                  }}
                  onPress={() => item.seasonNumber !== season && onSeason(item.seasonNumber)}
                />
              </View>
            ))}
          </ScrollView>
        </FocusGuide>
      </RowEdge>
      {position ? (
        <Text
          testID="series-episode-position"
          numberOfLines={1}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            fontSize: font(20, MIN_TEXT.caption),
            lineHeight: s(28),
            color: colors.foreground.muted,
          }}>
          {position}
        </Text>
      ) : null}
    </View>
  );
}

const RowEdge = MASK_FADE ? EdgeFade : PlainEdge;

function PlainEdge({ style, children }: EdgeFadeProps) {
  return <View style={style}>{children}</View>;
}
