import { useRouter } from 'expo-router';
import { Check, EyeOff, Film, Layers, Play, RotateCcw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMarkPlayed, useVersions, type WatchState } from '@/browse/queries';
import { GlassButton } from '@/components/glass';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { useFormat } from '@/i18n/format';
import { playHref, type PlayRequest } from '@/navigation/routes';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { useDesign } from '@/theme';

type WatchLike = Pick<WatchState, 'positionTicks' | 'durationTicks' | 'played'> | null | undefined;

/** Seconds to resume from (a played work being rewatched too), or 0 when there is no saved position. */
export function resumeSeconds(watch: WatchLike): number {
  if (!watch) return 0;
  return Math.max(0, (watch.positionTicks ?? 0) / TICKS_PER_SECOND);
}

/** 0..1 progress of a started, unfinished work, else undefined. */
export function watchProgress(watch: WatchLike): number | undefined {
  if (!watch?.durationTicks || !watch.positionTicks) return undefined;
  return Math.min(1, watch.positionTicks / watch.durationTicks);
}

export function usePlay() {
  const router = useRouter();
  return (request: PlayRequest) => router.push(playHref(request));
}

/** Resume progress under a title: bar plus the time left. */
export function ResumeProgress({
  watch,
  testID,
  barWidth,
}: {
  watch: WatchLike;
  testID?: string;
  /** Large detail: a short bar with the time right after it. */
  barWidth?: number;
}) {
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
        alignSelf: barWidth ? 'flex-start' : undefined,
      }}>
      <ProgressBar
        value={progress}
        size="md"
        style={barWidth ? { width: barWidth } : { flex: 1 }}
      />
      <Text variant="caption" tone="muted">
        {t('media.remaining', { time: format.duration(left) })}
      </Text>
    </View>
  );
}

/** The watched toggle with its toast ("“X” marked as watched"). */
export function useWatchedToggle({
  ids,
  played,
  title,
}: {
  ids: string[];
  played: boolean;
  title: string;
}) {
  const { t } = useTranslation();
  const mark = useMarkPlayed();
  const toast = useToast();
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
  return { toggle, pending: mark.isPending };
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
  /** Name in the watched toast (a series names the series, not the next episode); defaults to title. */
  markTitle?: string;
  testIDPrefix: string;
  /** Large shell: Aurora glass pills (Play, "Versions · N", round watched toggle). */
  shell?: boolean;
  /** Phone (Aurora C-phone): full-width solid Play and Start over only; Versions and Watched live elsewhere. */
  compact?: boolean;
  tint?: string | null;
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
  markTitle,
  testIDPrefix,
  shell = false,
  compact = false,
  tint,
}: TitleActionsProps) {
  const { t } = useTranslation();
  const play = usePlay();
  const versions = useVersions(workId);
  const noVersions = versions.data !== undefined && !versions.data.versions?.length;
  const resume = resumeSeconds(watch);
  const played = markPlayed ?? !!watch?.played;
  const playLabelKey = resume
    ? 'common.resume'
    : watch?.played
      ? 'common.watchAgain'
      : 'common.play';
  const ids = markWorkIds ?? (workId ? [workId] : []);

  const { toggle, pending } = useWatchedToggle({ ids, played, title: markTitle ?? title });

  if (compact) {
    if (!workId) return null;
    if (noVersions)
      return (
        <GlassButton
          testID={`${testIDPrefix}-no-versions`}
          icon={Film}
          label={t('common.noVersions')}
          disabled
          style={{ alignSelf: 'stretch' }}
        />
      );
    return (
      <>
        <GlassButton
          testID={`${testIDPrefix}-play`}
          tone="solid"
          icon={played && !resume ? RotateCcw : Play}
          label={playLabel ?? t(playLabelKey)}
          tint={tint}
          style={{ alignSelf: 'stretch' }}
          onPress={() => play({ workId, title, startSeconds: resume })}
        />
        {resume ? (
          <GlassButton
            testID={`${testIDPrefix}-start-over`}
            icon={RotateCcw}
            label={t('common.startOver')}
            tint={tint}
            style={{ alignSelf: 'stretch' }}
            onPress={() => play({ workId, title, startSeconds: 0 })}
          />
        ) : null}
      </>
    );
  }

  if (shell) {
    const count = versions.data?.versions?.length;
    return (
      <>
        {workId && noVersions ? (
          <GlassButton
            testID={`${testIDPrefix}-no-versions`}
            icon={Film}
            label={t('common.noVersions')}
            disabled
          />
        ) : workId ? (
          <GlassButton
            testID={`${testIDPrefix}-play`}
            tone="solid"
            icon={played && !resume ? RotateCcw : Play}
            label={playLabel ?? t(playLabelKey)}
            tint={tint}
            hasTVPreferredFocus
            onPress={() => play({ workId, title, startSeconds: resume })}
          />
        ) : null}
        {resume && workId && !noVersions ? (
          <GlassButton
            testID={`${testIDPrefix}-start-over`}
            icon={RotateCcw}
            label={t('common.startOver')}
            tint={tint}
            onPress={() => play({ workId, title, startSeconds: 0 })}
          />
        ) : null}
        {onVersions && !noVersions ? (
          <GlassButton
            testID={`${testIDPrefix}-versions`}
            icon={Layers}
            label={count ? t('common.versionsCount', { count }) : t('common.versions')}
            tint={tint}
            onPress={onVersions}
          />
        ) : null}
        {ids.length ? (
          <GlassButton
            testID={`${testIDPrefix}-mark`}
            iconOnly
            icon={played ? EyeOff : Check}
            label={t(played ? 'detail.markUnplayed' : 'detail.markPlayed')}
            tint={tint}
            disabled={pending}
            hasTVPreferredFocus={!workId || noVersions}
            onPress={toggle}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {workId && noVersions ? (
        <Button
          testID={`${testIDPrefix}-no-versions`}
          variant="secondary"
          icon={Film}
          label={t('common.noVersions')}
          disabled
        />
      ) : workId ? (
        <Button
          testID={`${testIDPrefix}-play`}
          icon={played && !resume ? RotateCcw : Play}
          label={playLabel ?? t(playLabelKey)}
          hasTVPreferredFocus
          onPress={() => play({ workId, title, startSeconds: resume })}
        />
      ) : null}
      {resume && workId && !noVersions ? (
        <Button
          testID={`${testIDPrefix}-start-over`}
          variant="secondary"
          icon={RotateCcw}
          label={t('common.startOver')}
          onPress={() => play({ workId, title, startSeconds: 0 })}
        />
      ) : null}
      {onVersions && !noVersions ? (
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
          icon={played ? EyeOff : Check}
          loading={pending}
          hasTVPreferredFocus={!workId || noVersions}
          label={t(played ? 'detail.markUnplayed' : 'detail.markPlayed')}
          onPress={toggle}
        />
      ) : null}
    </>
  );
}
