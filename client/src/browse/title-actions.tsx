import { useRouter } from 'expo-router';
import { Check, Film, Play, RotateCcw, Undo2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMarkPlayed, type WatchState } from '@/browse/queries';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { useFormat } from '@/i18n/format';
import { playHref, type PlayRequest } from '@/navigation/routes';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { useDesign } from '@/theme';

type WatchLike = Pick<WatchState, 'positionTicks' | 'durationTicks' | 'played'> | null | undefined;

/** Seconds to resume from, or 0 when the work was not started or is finished. */
export function resumeSeconds(watch: WatchLike): number {
  if (!watch || watch.played) return 0;
  return Math.max(0, (watch.positionTicks ?? 0) / TICKS_PER_SECOND);
}

/** 0..1 progress of a started, unfinished work, else undefined. */
export function watchProgress(watch: WatchLike): number | undefined {
  if (!watch || watch.played || !watch.durationTicks || !watch.positionTicks) return undefined;
  return Math.min(1, watch.positionTicks / watch.durationTicks);
}

export function usePlay() {
  const router = useRouter();
  return (request: PlayRequest) => router.push(playHref(request));
}

/** Resume progress under a title: bar plus the time left. */
export function ResumeProgress({ watch, testID }: { watch: WatchLike; testID?: string }) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const progress = watchProgress(watch);
  if (progress === undefined || !watch?.durationTicks) return null;
  const left = ((watch.durationTicks ?? 0) - (watch.positionTicks ?? 0)) / TICKS_PER_SECOND;
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: design.space.md,
        maxWidth: design.px(420),
      }}>
      <ProgressBar value={progress} size="md" style={{ flex: 1 }} />
      <Text variant="caption" tone="muted">
        {t('media.remaining', { time: format.duration(left) })}
      </Text>
    </View>
  );
}

export type TitleActionsProps = {
  workId: string | null | undefined;
  title: string;
  watch: WatchLike;
  /** Overrides the play label (series: "Play S1 E2"). */
  playLabel?: string;
  onVersions?: () => void;
  /** Works marked by the watched toggle (a series marks all its episodes); defaults to workId. */
  markWorkIds?: string[];
  /** State of the watched toggle when it differs from `watch` (a series: all episodes played). */
  markPlayed?: boolean;
  testIDPrefix: string;
};

/** Play/Resume, Start over, Versions and the watched toggle of a detail hero. */
export function TitleActions({
  workId,
  title,
  watch,
  playLabel,
  onVersions,
  markWorkIds,
  markPlayed,
  testIDPrefix,
}: TitleActionsProps) {
  const { t } = useTranslation();
  const play = usePlay();
  const mark = useMarkPlayed();
  const toast = useToast();
  const resume = resumeSeconds(watch);
  const played = markPlayed ?? !!watch?.played;
  const ids = markWorkIds ?? (workId ? [workId] : []);

  const toggle = () =>
    mark.mutate(
      { workIds: ids, played: !played },
      {
        onSuccess: () =>
          toast.show({
            message: t(played ? 'detail.markedUnplayed' : 'detail.markedPlayed', { title }),
            tone: 'success',
          }),
        onError: () => toast.show({ message: t('detail.markFailed'), tone: 'error' }),
      }
    );

  return (
    <>
      {workId ? (
        <Button
          testID={`${testIDPrefix}-play`}
          icon={Play}
          label={playLabel ?? t(resume ? 'common.resume' : 'common.play')}
          hasTVPreferredFocus
          onPress={() => play({ workId, title, startSeconds: resume })}
        />
      ) : null}
      {resume && workId ? (
        <Button
          testID={`${testIDPrefix}-start-over`}
          variant="secondary"
          icon={RotateCcw}
          label={t('common.startOver')}
          onPress={() => play({ workId, title, startSeconds: 0 })}
        />
      ) : null}
      {onVersions ? (
        <Button
          testID={`${testIDPrefix}-versions`}
          variant="secondary"
          icon={Film}
          label={t('common.versions')}
          onPress={onVersions}
        />
      ) : null}
      {ids.length ? (
        <Button
          testID={`${testIDPrefix}-mark`}
          variant="secondary"
          icon={played ? Undo2 : Check}
          loading={mark.isPending}
          hasTVPreferredFocus={!workId}
          label={t(played ? 'detail.markUnplayed' : 'detail.markPlayed')}
          onPress={toggle}
        />
      ) : null}
    </>
  );
}
