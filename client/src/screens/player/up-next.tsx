import { ArrowLeft, Play, RotateCcw } from 'lucide-react-native';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useSeasonDetail } from '@/browse/queries';
import { FocusGuide } from '@/components/focus';
import { Glass, GlassButton } from '@/components/glass';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { parseEpisodeWorkId } from '@/player/format';
import { usePlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';

export type NextEpisode = { workId: string; title: string };

const COUNTDOWN_SECONDS = 10;

// A version count of null means the server did not check; only a checked 0 rules the episode out.
const playable = (episode: { aired?: boolean; versionCount?: number | null }) =>
  episode.aired !== false && episode.versionCount !== 0;

/** The next playable episode after `workId` (in the season, else the first of the next season). */
export function useNextEpisode(workId: string): NextEpisode | null {
  const { t } = useTranslation();
  const parsed = parseEpisodeWorkId(workId);
  const season = useSeasonDetail(parsed?.tmdbId, parsed?.season, true);
  const inSeason = season.data?.episodes?.find(
    (episode) => episode.episodeNumber > (parsed?.episode ?? 0) && playable(episode)
  );
  const nextSeason = useSeasonDetail(
    parsed?.tmdbId,
    parsed && season.isSuccess && !inSeason ? parsed.season + 1 : undefined,
    true
  );
  const first = nextSeason.data?.episodes?.find(playable);
  const episode = inSeason ?? (nextSeason.isSuccess ? first : undefined);
  const seasonNumber = inSeason ? parsed?.season : (parsed?.season ?? 0) + 1;
  if (!parsed || !episode?.workId) return null;
  const code: string = t('media.episodeCode', {
    season: seasonNumber,
    episode: episode.episodeNumber,
  });
  return { workId: episode.workId, title: episode.title ? `${code} · ${episode.title}` : code };
}

type Props = {
  next: NextEpisode;
  onPlay: () => void;
  onCancel: () => void;
};

/** Up-next card with a countdown; plays the next episode when it runs out. */
export function UpNextCard({ next, onPlay, onCancel }: Props) {
  const pt = usePlayerT();
  const design = useDesign();
  const { large, s } = useShell();
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  const play = useEffectEvent(onPlay);

  useEffect(() => {
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (left <= 0) play();
  }, [left]);

  return (
    <Glass
      testID="player-up-next"
      intensity="strong"
      radius={large ? s(36) : design.radius.lg}
      style={{
        position: 'absolute',
        right: large ? s(64) : design.layout.gutter,
        bottom: large ? s(280) : design.layout.edgeVertical + design.px(110),
        width: large ? s(560) : design.px(320),
        padding: large ? s(32) : design.space.lg,
        gap: large ? s(12) : design.space.sm,
      }}>
      <Smoke radius={large ? s(36) : design.radius.lg} />
      <Text variant="overline" tone="muted">
        {pt('upNext.title')}
      </Text>
      <Text
        variant="subheading"
        numberOfLines={2}
        style={large && { fontFamily: fonts.displayBold, fontSize: s(34), lineHeight: s(42) }}>
        {next.title}
      </Text>
      <Text testID="player-up-next-countdown" variant="caption" tone="muted">
        {pt('upNext.countdown', { seconds: Math.max(0, left) })}
      </Text>
      <ProgressBar value={1 - Math.max(0, left) / COUNTDOWN_SECONDS} />
      <FocusGuide
        trap={['left', 'right', 'down']}
        style={{ flexDirection: 'row', gap: large ? s(14) : design.space.sm, marginTop: s(6) }}>
        <GlassButton
          testID="player-up-next-play"
          tone="solid"
          label={pt('upNext.playNow')}
          hasTVPreferredFocus
          onPress={onPlay}
        />
        <GlassButton
          testID="player-up-next-cancel"
          label={pt('upNext.cancel')}
          onPress={onCancel}
        />
      </FocusGuide>
    </Glass>
  );
}

/** Smoked underlay that keeps glass copy legible over bright video. */
function Smoke({ radius }: { radius: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: radius,
        backgroundColor: colors.glass.tinted,
        opacity: 0.7,
      }}
    />
  );
}

type EndCardProps = {
  title: string;
  next: NextEpisode | null;
  onReplay: () => void;
  onBack: () => void;
  onNext: () => void;
};

/** Shown when playback ended without an up-next countdown: replay, leave, or start the next episode. */
export function EndCard({ title, next, onReplay, onBack, onNext }: EndCardProps) {
  const pt = usePlayerT();
  const design = useDesign();
  const { large, s } = useShell();
  const preferred = useRef<View>(null);
  const hasNext = !!next;
  // The overlay behind may still hold native focus (e.g. up-next dismissed with Back).
  useEffect(() => {
    if (Platform.isTV) preferred.current?.requestTVFocus?.();
  }, [hasNext]);
  const radius = large ? s(44) : design.radius.xl;
  return (
    <View
      testID="player-end-card"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: design.layout.gutter,
        backgroundColor: colors.scrim.DEFAULT,
      }}>
      <Glass
        intensity="strong"
        radius={radius}
        style={{
          alignItems: 'center',
          maxWidth: large ? s(1100) : undefined,
          paddingHorizontal: large ? s(72) : design.space.xl,
          paddingVertical: large ? s(56) : design.space.xl,
          gap: large ? s(18) : design.space.lg,
        }}>
        <Smoke radius={radius} />
        <Text variant="overline" tone="muted">
          {pt('endCard.title')}
        </Text>
        <Text
          variant="title"
          numberOfLines={2}
          style={[
            { textAlign: 'center' },
            large && { fontFamily: fonts.displayBold, fontSize: s(64), lineHeight: s(74) },
          ]}>
          {title}
        </Text>
        <FocusGuide
          trap={['left', 'right', 'up', 'down']}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: large ? s(16) : design.space.md,
            marginTop: large ? s(12) : 0,
          }}>
          <GlassButton
            testID="player-end-replay"
            ref={next ? undefined : preferred}
            icon={RotateCcw}
            tone={next ? 'glass' : 'solid'}
            label={pt('endCard.replay')}
            hasTVPreferredFocus={!next}
            onPress={onReplay}
          />
          {next ? (
            <GlassButton
              testID="player-end-next"
              ref={preferred}
              icon={Play}
              tone="solid"
              label={pt('endCard.nextEpisode', { title: next.title })}
              hasTVPreferredFocus
              onPress={onNext}
            />
          ) : null}
          <GlassButton
            testID="player-end-back"
            icon={ArrowLeft}
            label={pt('endCard.backToDetails')}
            onPress={onBack}
          />
        </FocusGuide>
      </Glass>
    </View>
  );
}
