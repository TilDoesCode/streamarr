import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useSeasonDetail } from '@/browse/queries';
import { FocusGuide } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { parseEpisodeWorkId } from '@/player/format';
import { usePlayerT } from '@/player/use-player-t';
import { colors, useDesign } from '@/theme';

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
    <View
      testID="player-up-next"
      style={{
        position: 'absolute',
        right: design.layout.gutter,
        bottom: design.layout.edgeVertical + design.px(design.isTV ? 140 : 110),
        width: design.px(design.isTV ? 420 : 320),
        padding: design.space.lg,
        gap: design.space.sm,
        borderRadius: design.radius.lg,
        backgroundColor: colors.surface.overlay,
      }}>
      <Text variant="overline" tone="muted">
        {pt('upNext.title')}
      </Text>
      <Text variant="subheading" numberOfLines={2}>
        {next.title}
      </Text>
      <Text testID="player-up-next-countdown" variant="caption" tone="muted">
        {pt('upNext.countdown', { seconds: Math.max(0, left) })}
      </Text>
      <ProgressBar value={1 - Math.max(0, left) / COUNTDOWN_SECONDS} />
      <FocusGuide
        trap={['left', 'right', 'down']}
        style={{ flexDirection: 'row', gap: design.space.sm }}>
        <Button
          testID="player-up-next-play"
          label={pt('upNext.playNow')}
          size="sm"
          hasTVPreferredFocus
          onPress={onPlay}
        />
        <Button
          testID="player-up-next-cancel"
          label={pt('upNext.cancel')}
          size="sm"
          variant="secondary"
          onPress={onCancel}
        />
      </FocusGuide>
    </View>
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
  const preferred = useRef<View>(null);
  const hasNext = !!next;
  // The overlay behind may still hold native focus (e.g. up-next dismissed with Back).
  useEffect(() => {
    if (Platform.isTV) preferred.current?.requestTVFocus?.();
  }, [hasNext]);
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
        gap: design.space.lg,
        backgroundColor: colors.scrim.DEFAULT,
      }}>
      <Text variant="overline" tone="muted">
        {pt('endCard.title')}
      </Text>
      <Text variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
        {title}
      </Text>
      <FocusGuide
        trap={['left', 'right', 'up', 'down']}
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: design.space.md,
        }}>
        <Button
          testID="player-end-replay"
          ref={next ? undefined : preferred}
          label={pt('endCard.replay')}
          hasTVPreferredFocus={!next}
          onPress={onReplay}
        />
        {next ? (
          <Button
            testID="player-end-next"
            ref={preferred}
            label={pt('endCard.nextEpisode', { title: next.title })}
            hasTVPreferredFocus
            onPress={onNext}
          />
        ) : null}
        <Button
          testID="player-end-back"
          label={pt('endCard.backToDetails')}
          variant="secondary"
          onPress={onBack}
        />
      </FocusGuide>
    </View>
  );
}
