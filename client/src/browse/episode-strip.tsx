import { ChevronRight, Play, Tv } from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionSheetIOS,
  FlatList,
  Platform,
  View,
  type GestureResponderEvent,
  type ListRenderItemInfo,
} from 'react-native';

import type { Episode } from '@/browse/queries';
import { resumeSeconds, watchProgress } from '@/browse/title-actions';
import { END_OF_ROW, FocusGuide, Focusable, FocusLift, useFocusGlowRoom } from '@/components/focus';
import { Glass } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { PlayedMark, useCardGap, useCardScale, useFocusRoom } from '@/components/media/card-parts';
import { EmptyState } from '@/components/states/empty-state';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { MIN_TEXT, SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';
import { META_SEPARATOR } from '@/lib/media-labels';

/** One corner badge: two wrap on a 233 px web card (Q1-03); "No version" wins, the stage pill already says next. */
export function cardBadges({ next, noVersion }: { next: boolean; noVersion: boolean }) {
  if (noVersion) return ['detail.noVersionShort'] as const;
  return next ? (['media.upNext'] as const) : [];
}

/** A card without a still: its number moves to the bottom-left corner when a badge or the ▶ may cover the middle. */
export function numberInCorner({ badges, touch }: { badges: number; touch: boolean }): boolean {
  return touch || badges > 0;
}

/** TV marks the selected card by its caption bar only: a ring would read as a second focus ring. */
export function showsSelectionRing(selected: boolean, isTV: boolean) {
  return selected && !isTV;
}

/** D2 episode card (1920 × 1080 points) and the caption block under it (title, subline, selection bar). */
export const EPISODE_CARD = { width: 352, height: 198, radius: 20, caption: 76, bar: 5 } as const;
const CONTINUE_WIDTH = 220;

export type EpisodeStripProps = {
  episodes: readonly Episode[] | undefined;
  /** Episode number shown on the stage above (marked). */
  selected?: number;
  nextWorkId?: string | null;
  /** Fallback art for episodes without a still. */
  backdropUrl?: string | null;
  tint?: string | null;
  /** Scroll target changes (season switch, first load): the strip brings the selection to its start. */
  scrollKey: string;
  /** Gutter the first card starts at (the strip itself bleeds to the screen edges). */
  gutterStart: number;
  gutterEnd: number;
  /** "Continue with Season 2 ›" after the last card. */
  continueLabel?: string;
  onContinue?: () => void;
  /** TV: focus rests on a card (the caller debounces the preview). */
  onPreview: (episode: Episode) => void;
  /** Touch/pointer: a tap marks the card. */
  onSelect: (episode: Episode) => void;
  /** `fromStart`: "Start over" from the iPad context menu. */
  onPlay: (episode: Episode, fromStart?: boolean) => void;
  /** Long press: the versions of that episode (iPad: a context menu offers it next to Play). */
  onVersions: (episode: Episode) => void;
  /** TV: focus entered (true) or left (false) the strip. */
  onFocusInside?: (inside: boolean) => void;
};

/** Episodes of one season side by side; focus (TV) or a tap marks one, Select / ▶ plays it. */
export function EpisodeStrip({
  episodes,
  selected,
  nextWorkId,
  backdropUrl,
  tint,
  scrollKey,
  gutterStart,
  gutterEnd,
  continueLabel,
  onContinue,
  onPreview,
  onSelect,
  onPlay,
  onVersions,
  onFocusInside,
}: EpisodeStripProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  const width = s(EPISODE_CARD.width);
  const artHeight = s(EPISODE_CARD.height);
  const gap = useCardGap();
  const stride = width + gap;
  const focusRoom = useFocusRoom(artHeight);
  const glowRoom = Math.max(
    0,
    useFocusGlowRoom() - design.focus.ringOffset - design.focus.ringWidth - design.px(4)
  );
  const listRef = useRef<FlatList<Episode>>(null);
  const [selectedCard, setSelectedCard] = useState<View | null>(null);
  const [inside, setInside] = useState(false);
  // Web: the strip is one Tab stop (roving tabindex); arrow keys move between the cards.
  const cards = useRef(new Map<number, View>());
  const pendingFocus = useRef<number | null>(null);
  const [focusedCard, setFocusedCard] = useState<number | null>(null);
  const height = artHeight + s(EPISODE_CARD.caption) + 2 * (focusRoom + glowRoom);
  const index = episodes?.findIndex((episode) => episode.episodeNumber === selected) ?? -1;

  // The marked card is the TV entry destination.
  const markedNumber = index >= 0 ? selected : undefined;
  const marked = useRef(markedNumber);
  const refCallbacks = useRef(new Map<number, (view: View | null) => void>());
  const cardRef = (episode: Episode) => {
    const number = episode.episodeNumber;
    let callback = refCallbacks.current.get(number);
    if (!callback) {
      callback = (view: View | null) => {
        if (view) cards.current.set(number, view);
        else cards.current.delete(number);
        if (number === marked.current) setSelectedCard(view);
        if (view && pendingFocus.current === number) {
          pendingFocus.current = null;
          view.focus();
        }
      };
      refCallbacks.current.set(number, callback);
    }
    return callback;
  };
  useEffect(() => {
    marked.current = markedNumber;
    setSelectedCard(markedNumber === undefined ? null : (cards.current.get(markedNumber) ?? null));
  }, [markedNumber, episodes]);

  // Season switch / first load: the marked card starts at the gutter (TV geometry then hits it first).
  const loaded = !!episodes?.length;
  // A size change (rotation, window resize) brings the marked card back too (Q1-50).
  useEffect(() => {
    if (!loaded || index < 0) return;
    listRef.current?.scrollToOffset({
      offset: design.isTV ? stripOffset(index, gutterStart, stride) : index * stride,
      animated: false,
    });
    // Only the scroll key and the card size move the strip; taps and focus scroll by themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, loaded, index >= 0, stride]);
  const clip = stripClip(design.isTV, design.inset, gutterStart);

  if (!episodes)
    return (
      <View
        testID="episode-strip-loading"
        style={{ height, flexDirection: 'row', gap, paddingLeft: gutterStart }}>
        {[0, 1, 2, 3].map((item) => (
          <View key={item} style={{ paddingVertical: focusRoom + glowRoom, gap: s(12) }}>
            <Skeleton width={width} height={artHeight} radius={s(EPISODE_CARD.radius)} />
            <Skeleton width={width * 0.7} height={s(24)} radius={s(6)} />
          </View>
        ))}
      </View>
    );

  if (!episodes.length)
    return (
      <View style={{ paddingLeft: gutterStart, paddingRight: gutterEnd }}>
        <EmptyState
          testID="episodes-empty"
          icon={Tv}
          title={t('detail.noEpisodesTitle')}
          message={t('detail.noEpisodesMessage')}
        />
      </View>
    );

  const tabStop = rovingTabStop(episodes, focusedCard, index >= 0 ? selected : undefined);
  const focusCard = (at: number) => {
    const target = episodes[Math.max(0, Math.min(episodes.length - 1, at))];
    if (!target) return;
    listRef.current?.scrollToIndex({ index: episodes.indexOf(target), viewPosition: 0.5 });
    const view = cards.current.get(target.episodeNumber);
    if (view) view.focus();
    else pendingFocus.current = target.episodeNumber;
  };

  const renderCell = ({ item, index: at }: ListRenderItemInfo<Episode>) => (
    <View
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'start' : undefined}
      style={{ marginRight: at < episodes.length - 1 || onContinue ? gap : 0 }}>
      <EpisodeCard
        episode={item}
        selected={item.episodeNumber === selected}
        next={!!nextWorkId && item.workId === nextWorkId}
        backdropUrl={backdropUrl}
        tint={tint}
        cardRef={cardRef(item)}
        tabStop={item.episodeNumber === tabStop}
        onKeyMove={(step) =>
          focusCard(step === 'first' ? 0 : step === 'last' ? episodes.length - 1 : at + step)
        }
        onWebFocus={() => setFocusedCard(item.episodeNumber)}
        onPreview={onPreview}
        onSelect={onSelect}
        onPlay={onPlay}
        onVersions={onVersions}
      />
    </View>
  );

  return (
    <FocusGuide
      testID="episode-strip"
      remember
      trap={END_OF_ROW}
      // Entering from above lands on the marked card, also after a season switch.
      destinations={!inside && selectedCard ? [selectedCard] : EMPTY}
      onFocusEnter={() => {
        setInside(true);
        onFocusInside?.(true);
      }}
      onFocusLeave={() => {
        setInside(false);
        onFocusInside?.(false);
      }}
      style={{ height }}>
      <FlatList
        ref={listRef}
        horizontal
        data={episodes}
        keyExtractor={(episode) => String(episode.episodeNumber)}
        renderItem={renderCell}
        showsHorizontalScrollIndicator={false}
        style={{ height, marginVertical: 0, marginLeft: clip.left }}
        contentContainerStyle={{
          paddingLeft: clip.paddingLeft,
          paddingRight: gutterEnd,
          paddingVertical: focusRoom + glowRoom,
        }}
        getItemLayout={(_, at) => ({
          length: stride,
          offset: clip.paddingLeft + at * stride,
          index: at,
        })}
        initialNumToRender={design.isTV ? 12 : 6}
        windowSize={design.isTV ? 9 : 5}
        removeClippedSubviews={false}
        snapToAlignment={design.isTV ? 'item' : undefined}
        snapToItemPadding={design.isTV ? stripSnapPadding(gutterStart, stride) : undefined}
        ListFooterComponent={
          onContinue && continueLabel ? (
            <ContinueCard label={continueLabel} onPress={onContinue} />
          ) : null
        }
      />
    </FocusGuide>
  );
}

const EMPTY: View[] = [];

/** Touch and web: the strip starts at the rail's edge (cards never scroll under it, Q1-49); TV stays full bleed. */
export function stripClip(isTV: boolean, railInset: number, gutterStart: number) {
  const left = isTV ? 0 : Math.min(railInset, gutterStart);
  return { left, paddingLeft: gutterStart - left };
}

/** TV: a focused card snaps one card in from the gutter, so from the second card on one episode stays left of it. */
function stripSnapPadding(gutterStart: number, stride: number): number {
  return gutterStart + stride;
}

/** TV scroll offset that shows card `index` where focus would put it (the first card at the gutter). */
export function stripOffset(index: number, gutterStart: number, stride: number): number {
  return Math.max(0, gutterStart + index * stride - stripSnapPadding(gutterStart, stride));
}

/** Web: the one card in the Tab order — the last focused one, else the marked one, else the first. */
export function rovingTabStop(
  episodes: readonly Pick<Episode, 'episodeNumber'>[],
  focused: number | null,
  marked: number | undefined
): number | undefined {
  const has = (number: number | null | undefined) =>
    episodes.some((episode) => episode.episodeNumber === number);
  if (has(focused)) return focused!;
  return has(marked) ? marked : episodes[0]?.episodeNumber;
}

export const MOVE_KEYS: Record<string, -1 | 1 | 'first' | 'last'> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  Home: 'first',
  End: 'last',
};

function moveKey(event: unknown, onKeyMove: (step: -1 | 1 | 'first' | 'last') => void) {
  const { key, preventDefault } = event as { key: string; preventDefault: () => void };
  const step = MOVE_KEYS[key];
  if (step === undefined) return;
  preventDefault.call(event);
  onKeyMove(step);
}

function EpisodeCard({
  episode,
  selected,
  next,
  backdropUrl,
  tint,
  cardRef,
  tabStop,
  onKeyMove,
  onWebFocus,
  onPreview,
  onSelect,
  onPlay,
  onVersions,
}: {
  episode: Episode;
  selected: boolean;
  next: boolean;
  backdropUrl?: string | null;
  tint?: string | null;
  cardRef?: (view: View | null) => void;
  tabStop: boolean;
  onKeyMove: (step: -1 | 1 | 'first' | 'last') => void;
  onWebFocus: () => void;
  onPreview: (episode: Episode) => void;
  onSelect: (episode: Episode) => void;
  onPlay: (episode: Episode, fromStart?: boolean) => void;
  onVersions: (episode: Episode) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const { s, font } = useShell();
  const width = s(EPISODE_CARD.width);
  const height = s(EPISODE_CARD.height);
  const radius = s(EPISODE_CARD.radius);
  const scale = useCardScale(width);
  const title = episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber });
  const notAired = episode.aired === false || !episode.workId;
  const noVersion = !notAired && episode.versionCount === 0;
  const played = !!episode.watch.played;
  // A replay of a watched episode shows both: the watched mark and its resume progress.
  const progress = watchProgress(episode.watch);
  const left =
    ((episode.watch.durationTicks ?? 0) - (episode.watch.positionTicks ?? 0)) / TICKS_PER_SECOND;
  const badges = cardBadges({ next, noVersion }).map((key) => t(key));
  const corner = numberInCorner({ badges: badges.length, touch: !design.isTV });
  const subline = notAired
    ? episode.airDate
      ? t('detail.airsOn', { date: format.date(episode.airDate) })
      : t('detail.notAired')
    : noVersion
      ? t('detail.noVersionShort')
      : progress !== undefined
        ? format.remaining(left)
        : played
          ? t('media.played')
          : episode.runtimeMinutes
            ? format.duration(episode.runtimeMinutes * 60)
            : '';
  const touch = !design.isTV;
  const inset = s(14);
  const [hover, setHover] = useState(false);
  const [overlayHover, setOverlayHover] = useState(false);
  const web = Platform.OS === 'web';
  const playable = !notAired && !noVersion;
  // iPad: Play · Start over · Versions as a popover at the card; elsewhere the long press opens the versions.
  const longPress = (event: GestureResponderEvent) => {
    if (Platform.OS !== 'ios' || design.isTV) return onVersions(episode);
    const started = resumeSeconds(episode.watch) > 0 || played;
    const actions = [
      {
        label: t(resumeSeconds(episode.watch) > 0 ? 'common.resume' : 'common.play'),
        run: () => onPlay(episode),
      },
      ...(started ? [{ label: t('common.startOver'), run: () => onPlay(episode, true) }] : []),
      { label: t('common.versions'), run: () => onVersions(episode) },
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: label,
        options: [...actions.map((action) => action.label), t('common.cancel')],
        cancelButtonIndex: actions.length,
        anchor: event.nativeEvent.target as unknown as number,
      },
      (index) => actions[index]?.run()
    );
  };
  const label = [
    t('media.episodeNumber', { episode: episode.episodeNumber }),
    title,
    subline,
    next ? t('media.upNext') : null,
  ]
    .filter(Boolean)
    .join(META_SEPARATOR);

  return (
    <View style={{ width }}>
      <Focusable
        ref={cardRef}
        testID={`episode-card-${episode.episodeNumber}`}
        role="button"
        accessibilityLabel={label}
        accessibilityHint={touch ? t('detail.episodeSelectHint') : undefined}
        aria-selected={selected}
        {...(web
          ? { tabIndex: tabStop ? 0 : -1, onKeyDown: (event: unknown) => moveKey(event, onKeyMove) }
          : null)}
        onFocus={design.isTV ? () => onPreview(episode) : web ? onWebFocus : undefined}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        onPress={(event) => {
          if (design.isTV) return onPlay(episode);
          // Web: the second click of a double click plays the card it just marked.
          const clicks = (event.nativeEvent as { detail?: number }).detail;
          if (web && clicks === 2 && playable) return onPlay(episode);
          onSelect(episode);
        }}
        onLongPress={playable ? (event) => longPress(event) : undefined}>
        <FocusLift kind="card" radius={radius} tint={tint} scale={scale}>
          <View
            style={{
              width,
              height,
              borderRadius: radius,
              borderCurve: 'continuous',
              overflow: 'hidden',
            }}>
            <View style={{ flex: 1 }}>
              {episode.stillUrl ? (
                <Artwork uri={episode.stillUrl} title={title} />
              ) : (
                <>
                  <Artwork uri={backdropUrl} />
                  <View
                    testID={`episode-card-${episode.episodeNumber}-number`}
                    style={{
                      flex: 1,
                      alignItems: corner ? 'flex-start' : 'center',
                      justifyContent: corner ? 'flex-end' : 'center',
                      padding: corner ? inset : 0,
                      backgroundColor: colors.scrim.DEFAULT,
                    }}>
                    <Text
                      style={{
                        fontFamily: fonts.displayBold,
                        fontSize: s(corner ? 56 : 96),
                        lineHeight: s(corner ? 60 : 104),
                        color: colors.foreground.DEFAULT,
                      }}>
                      {episode.episodeNumber}
                    </Text>
                  </View>
                </>
              )}
            </View>
            {notAired || noVersion ? (
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: colors.scrim.strong,
                  opacity: 0.65,
                }}
              />
            ) : null}
            {badges.length ? (
              <View
                testID={`episode-card-${episode.episodeNumber}-badges`}
                style={{
                  position: 'absolute',
                  top: inset,
                  left: inset,
                  right: inset,
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: s(8),
                }}>
                {badges.map((badge) => (
                  <Badge key={badge} label={badge} variant="solid" />
                ))}
              </View>
            ) : null}
            {played ? <PlayedMark /> : null}
            {progress !== undefined ? (
              <ProgressBar
                value={progress}
                onMedia
                style={{ position: 'absolute', left: inset, right: inset, bottom: inset }}
              />
            ) : null}
            {showsSelectionRing(selected, design.isTV) ? (
              <View
                testID={`episode-card-${episode.episodeNumber}-selected`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  borderRadius: radius,
                  borderWidth: s(3),
                  borderColor: colors.foreground.DEFAULT,
                  opacity: 0.85,
                }}
              />
            ) : null}
          </View>
        </FocusLift>
        <View style={{ paddingTop: s(14) }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.bodySemiBold,
              fontSize: font(SHELL.type.cardTitle, MIN_TEXT.caption),
              lineHeight: font(28, MIN_TEXT.caption + 5),
              color: selected ? colors.foreground.DEFAULT : colors.foreground.muted,
            }}>
            <Text style={{ color: colors.foreground.subtle }}>{`${episode.episodeNumber}  `}</Text>
            {title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontSize: font(SHELL.type.cardSubline, MIN_TEXT.subline),
              lineHeight: font(22, MIN_TEXT.subline + 5),
              color: notAired || noVersion ? colors.warning.DEFAULT : colors.foreground.subtle,
            }}>
            {subline}
          </Text>
          <View
            style={{
              marginTop: s(6),
              width: s(46),
              height: s(EPISODE_CARD.bar),
              borderRadius: s(EPISODE_CARD.bar),
              backgroundColor: selected ? colors.foreground.DEFAULT : 'transparent',
            }}
          />
        </View>
      </Focusable>
      {touch && playable && (selected || hover || overlayHover) ? (
        <PlayOverlay
          testID={`episode-card-${episode.episodeNumber}-play`}
          label={t('detail.playEpisode', { title })}
          // Web: a small ▶ in the corner, so a click on the card marks it (double click still plays).
          top={web ? height - s(40) : height / 2}
          left={web ? width - s(40) : width / 2}
          size={web ? s(52) : s(72)}
          onPress={() => onPlay(episode)}
          onHover={setOverlayHover}
        />
      ) : null}
    </View>
  );
}

/** Touch/pointer: ▶ over the marked card plays it (a sibling of the card, never a nested button). */
function PlayOverlay({
  label,
  top,
  left,
  testID,
  size,
  onPress,
  onHover,
}: {
  label: string;
  top: number;
  left: number;
  size: number;
  testID: string;
  onPress: () => void;
  onHover: (hovered: boolean) => void;
}) {
  return (
    <Focusable
      testID={testID}
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => onHover(true)}
      onHoverOut={() => onHover(false)}
      style={{ position: 'absolute', top: top - size / 2, left: left - size / 2 }}>
      <FocusLift kind="button" radius={size / 2}>
        <Glass interactive intensity="strong" radius={size / 2}>
          <View
            style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Play
              size={Math.round(size * 0.42)}
              color={colors.foreground.DEFAULT}
              fill={colors.foreground.DEFAULT}
            />
          </View>
        </Glass>
      </FocusLift>
    </Focusable>
  );
}

function ContinueCard({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useTranslation();
  const { s } = useShell();
  const radius = s(EPISODE_CARD.radius);
  return (
    <Focusable
      testID="episode-strip-continue"
      role="button"
      accessibilityLabel={`${t('detail.continueWith')} ${label}`}
      onPress={onPress}>
      <FocusLift kind="card" radius={radius}>
        <Glass radius={radius} intensity="subtle">
          <View
            style={{
              width: s(CONTINUE_WIDTH),
              height: s(EPISODE_CARD.height),
              padding: s(26),
              justifyContent: 'center',
              gap: s(6),
            }}>
            <Text style={{ fontSize: s(18), lineHeight: s(24), color: colors.foreground.muted }}>
              {t('detail.continueWith')}
            </Text>
            <Text
              numberOfLines={2}
              style={{ fontFamily: fonts.displayBold, fontSize: s(28), lineHeight: s(34) }}>
              {label}
            </Text>
            <ChevronRight size={s(26)} color={colors.foreground.muted} />
          </View>
        </Glass>
      </FocusLift>
    </Focusable>
  );
}
