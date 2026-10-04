import { useRouter } from 'expo-router';
import { Check, EyeOff, Film, Layers, Play, RotateCcw } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSyncExternalStore, type Ref } from 'react';

import { playTarget, type PlayAction } from '@/browse/play-target';
import {
  useFetchVersions,
  useMarkPlayed,
  useVersions,
  type Version,
  type WatchState,
} from '@/browse/queries';
import { useTvPreferredFocus } from '@/components/focus';
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
type PlayWatch = { lastReleaseId?: string | null } | null | undefined;
/** What the play rule reads from a watch state (resume point and last played version). */
export type PlayWatchState = WatchLike & PlayWatch;

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

/** The main button's action and the version it starts (shared by the buttons and the chip row). */
export function usePlayTarget(workId: string | null | undefined, watch: WatchLike & PlayWatch) {
  const versions = useVersions(workId);
  const action: PlayAction = resumeSeconds(watch) ? 'resume' : 'play';
  const list = versions.data ? (versions.data.versions ?? []) : undefined;
  const target = playTarget(list, watch, action, versions.isError);
  return { action, target, versions: list ?? [] };
}

export function usePlay() {
  const router = useRouter();
  return (request: PlayRequest) => router.push(playHref(request));
}

/** Play request by the playTarget rule: Resume starts the version last played, like the detail's button. */
export async function resolvePlay(
  fetchVersions: (workId: string) => Promise<readonly Version[]>,
  { workId, title, watch }: { workId: string; title: string; watch: PlayWatchState }
): Promise<PlayRequest> {
  const startSeconds = resumeSeconds(watch);
  const request = { workId, title, startSeconds };
  // Without a last played version the server's recommendation starts anyway.
  if (!startSeconds || !watch?.lastReleaseId) return request;
  try {
    const target = playTarget(await fetchVersions(workId), watch, 'resume');
    return target.state === 'ready' && target.releaseId
      ? { ...request, releaseId: target.releaseId }
      : request;
  } catch {
    return request;
  }
}

/** Single flight for every card and hero: the work whose play request is resolving (null = none). */
export const playPending = {
  workId: null as string | null,
  listeners: new Set<() => void>(),
  set(workId: string | null) {
    this.workId = workId;
    for (const listener of this.listeners) listener();
  },
  subscribe: (listener: () => void) => {
    playPending.listeners.add(listener);
    return () => void playPending.listeners.delete(listener);
  },
  get: () => playPending.workId,
};

/** True while this work's play request resolves (the card stays focusable, presses are ignored). */
export function usePlayPending(workId: string | null | undefined): boolean {
  return useSyncExternalStore(playPending.subscribe, playPending.get) === (workId ?? undefined);
}

/** Plays a work from a card or the Home hero with the same version the detail would start; one press at a time. */
export function usePlayWork() {
  const play = usePlay();
  const fetchVersions = useFetchVersions();
  return (work: { workId: string; title: string; watch: PlayWatchState }) => {
    if (playPending.workId) return;
    playPending.set(work.workId);
    void resolvePlay(fetchVersions, work)
      .then(play)
      .finally(() => playPending.set(null));
  };
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
  watch: WatchLike & PlayWatch;
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
  /** TV: the main button takes the first focus when it appears (series: only before any selection). */
  preferFocus?: boolean;
  /** Large shell: the main button (Back from the episode strip focuses it on Android TV). */
  mainRef?: Ref<View>;
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
  preferFocus = true,
  mainRef,
}: TitleActionsProps) {
  const { t } = useTranslation();
  const play = usePlay();
  const { target, versions: list } = usePlayTarget(workId, watch);
  const noVersions = target.state === 'none';
  // Versions shows once they arrived: a button that vanishes on "No versions yet" would drop TV focus.
  const loading = !!workId && target.state === 'loading';
  const resume = resumeSeconds(watch);
  // The version the chip row (large) or the version card (phone) names.
  const releaseId = target.state === 'ready' ? target.releaseId : undefined;
  const played = markPlayed ?? !!watch?.played;
  const playLabelKey = resume
    ? 'common.resume'
    : watch?.played
      ? 'common.watchAgain'
      : 'common.play';
  const ids = markWorkIds ?? (workId ? [workId] : []);

  const { toggle, pending } = useWatchedToggle({ ids, played, title: markTitle ?? title });
  const mainButton = useTvPreferredFocus(preferFocus, mainRef);

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
          onPress={() => play({ workId, title, releaseId, startSeconds: resume })}
        />
        {resume ? (
          <GlassButton
            testID={`${testIDPrefix}-start-over`}
            icon={RotateCcw}
            label={t('common.startOver')}
            tint={tint}
            style={{ alignSelf: 'stretch' }}
            onPress={() => play({ workId, title, releaseId, startSeconds: 0 })}
          />
        ) : null}
      </>
    );
  }

  if (shell) {
    const count = list.length || undefined;
    return (
      <>
        {workId && noVersions ? (
          <GlassButton
            testID={`${testIDPrefix}-no-versions`}
            icon={Film}
            label={t('common.noVersions')}
            // TV: the inert note takes the first focus, so a stray Select changes nothing.
            disabled={!Platform.isTV}
            hasTVPreferredFocus={preferFocus}
            ref={mainButton}
          />
        ) : workId ? (
          <GlassButton
            testID={`${testIDPrefix}-play`}
            tone="solid"
            icon={played && !resume ? RotateCcw : Play}
            label={playLabel ?? t(playLabelKey)}
            tint={tint}
            hasTVPreferredFocus={preferFocus}
            ref={mainButton}
            onPress={() => play({ workId, title, releaseId, startSeconds: resume })}
          />
        ) : null}
        {resume && workId && !noVersions ? (
          <GlassButton
            testID={`${testIDPrefix}-start-over`}
            icon={RotateCcw}
            label={t('common.startOver')}
            tint={tint}
            onPress={() => play({ workId, title, releaseId, startSeconds: 0 })}
          />
        ) : null}
        {onVersions && !noVersions && !loading ? (
          <GlassButton
            testID={`${testIDPrefix}-versions`}
            icon={Layers}
            label={
              count === 1
                ? t('detail.details')
                : count
                  ? t('common.versionsCount', { count })
                  : t('common.versions')
            }
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
            hasTVPreferredFocus={preferFocus && !workId}
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
          onPress={() => play({ workId, title, releaseId, startSeconds: resume })}
        />
      ) : null}
      {resume && workId && !noVersions ? (
        <Button
          testID={`${testIDPrefix}-start-over`}
          variant="secondary"
          icon={RotateCcw}
          label={t('common.startOver')}
          onPress={() => play({ workId, title, releaseId, startSeconds: 0 })}
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
