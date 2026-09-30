'use no memo';
import { useQueryClient } from '@tanstack/react-query';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { invalidateWatchQueries } from '@/browse/queries';
import { VersionPicker } from '@/browse/version-picker';
import { CENTRED_ROW, FocusGuide, useBackHandler } from '@/components/focus';
import { ErrorState, type ErrorAction } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import { playHref } from '@/navigation/routes';
import { PlaybackController } from '@/player/controller';
import { loadDeviceCaps } from '@/player/device-profile';
import { nativeCandidates } from '@/player/engines';
import { clock } from '@/player/format';
import type { PlaybackPreferences } from '@/player/playback-api';
import { useClock } from '@/player/use-clock';
import { usePlayerT } from '@/player/use-player-t';
import { colors, useDesign } from '@/theme';

import { PlayerOverlay } from './player-overlay';
import { PlayerPanels, type PanelKind } from './player-panels';
import { StartStepper } from './start-stepper';
import { UpNextCard, useNextEpisode } from './up-next';

type Params = {
  playbackId: string;
  workId?: string;
  releaseId?: string;
  start?: string;
  title?: string;
};

const SERVER_ACTIONS = new Set<ErrorAction>(['retry', 'otherVersion', 'lowerQuality', 'useVlc']);
const UP_NEXT_SECONDS = 15;
const NOTICE_MS = 6000;

/** Player route: start flow with the stepper, resume choice, overlay, panels, up-next and errors. */
export function PlayScreen() {
  const pt = usePlayerT();
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const [controller, setController] = useState<PlaybackController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<PlaybackPreferences>({ engine: 'auto' });
  const [releaseId, setReleaseId] = useState(params.releaseId || undefined);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [picker, setPicker] = useState(false);
  const [upNextDismissedFor, setUpNextDismissedFor] = useState<string | null>(null);
  const overlayBack = useRef<(() => boolean) | null>(null);
  const workId = params.workId ?? '';
  const title = params.title ?? '';
  const startSeconds = params.start === undefined ? undefined : Number(params.start) || 0;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getVersion ?? zero,
    controller?.getVersion ?? zero
  );
  const clockState = useClock(controller?.engine);
  const next = useNextEpisode(workId);

  useEffect(() => {
    if (!workId) return;
    let cancelled = false;
    let current: PlaybackController | null = null;
    loadDeviceCaps()
      .then((caps) => {
        if (cancelled) return;
        current = new PlaybackController({
          client,
          accountId: account.id,
          serverUrl: account.serverUrl,
          profile: caps.profile,
          nativeEngine: nativeCandidates()[0] ?? 'web',
          workId,
          releaseId,
          startSeconds,
          preferences,
        });
        setController(current);
        if (__DEV__) (globalThis as { __streamarrPlayer?: unknown }).__streamarrPlayer = current;
        void current.start();
      })
      .catch((error: unknown) => {
        if (!cancelled) setCapsError(toAppError(error).code);
      });
    return () => {
      cancelled = true;
      void current?.stop().finally(() => void invalidateWatchQueries(queryClient, account.id));
    };
    // A retry, another version or other preferences restart the whole start flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, releaseId, attempt, preferences]);

  useEffect(() => {
    if (design.formFactor !== 'phone') return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(
      () => undefined
    );
    return () => void ScreenOrientation.unlockAsync().catch(() => undefined);
  }, [design.formFactor]);

  const notice = controller?.notice;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => controller?.dismissNotice(), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, controller]);

  const phase = controller?.phase ?? 'starting';
  const failed = phase === 'failed' || !!capsError || !workId;
  const playing = phase === 'playing' || phase === 'switching';
  const remaining = (clockState.duration || 0) - clockState.position;
  const showUpNext =
    !!next &&
    playing &&
    upNextDismissedFor !== workId &&
    panel === null &&
    (controller?.ended || (clockState.duration > 0 && remaining <= UP_NEXT_SECONDS));

  const playNext = () => {
    if (!next) return;
    router.replace(playHref({ workId: next.workId, title: next.title, startSeconds: 0 }));
  };

  useBackHandler(() => {
    if (picker) setPicker(false);
    else if (panel) setPanel(null);
    else if (showUpNext) setUpNextDismissedFor(workId);
    else if (!(playing && overlayBack.current?.())) close();
    return true;
  });

  const onFailureAction = (action: ErrorAction) => {
    setCapsError(null);
    if (action === 'retry') setAttempt((value) => value + 1);
    else if (action === 'otherVersion') setPicker(true);
    else if (action === 'lowerQuality') setPreferences((value) => ({ ...value, maxHeight: 720 }));
    else if (action === 'useVlc') setPreferences((value) => ({ ...value, engine: 'vlc' }));
    else close();
  };

  const failure = controller?.failure;
  const code = capsError ?? failure?.code ?? (workId ? 'unknown' : 'not_found');
  const actions: ErrorAction[] = [
    ...(failure?.actions ?? ['retry']).filter((action): action is ErrorAction =>
      SERVER_ACTIONS.has(action as ErrorAction)
    ),
    'back',
  ];
  const top = Math.max(insets.top, design.layout.edgeVertical);

  return (
    <View
      testID={`play-screen-${params.playbackId}`}
      style={{ flex: 1, backgroundColor: colors.video }}>
      {controller && playing ? (
        <PlayerOverlay
          controller={controller}
          clock={clockState}
          title={title}
          suspended={panel !== null || picker || showUpNext}
          onPanel={setPanel}
          onClose={close}
          backRef={overlayBack}
        />
      ) : null}
      {failed ? (
        <ScrollView
          contentContainerStyle={[
            styles.centre,
            { padding: design.layout.gutter, gap: design.space.xl },
          ]}>
          {controller?.states.length ? (
            <StartStepper playback={controller.playback} states={controller.states} failed />
          ) : null}
          <ErrorState
            testID="play-error"
            code={code}
            params={failure?.params}
            actions={workId ? actions : ['back']}
            autoFocus={!picker}
            onAction={onFailureAction}
          />
        </ScrollView>
      ) : phase === 'resume' && controller ? (
        <View testID="play-resume" style={[styles.fill, styles.centre, { gap: design.space.lg }]}>
          <Text variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
            {pt('resume.title')}
          </Text>
          <FocusGuide trap={CENTRED_ROW} style={{ flexDirection: 'row', gap: design.space.md }}>
            <Button
              testID="play-resume-yes"
              label={pt('resume.resume', { time: clock(controller.resumeSeconds) })}
              hasTVPreferredFocus
              onPress={() => controller.chooseStart(true)}
            />
            <Button
              testID="play-resume-no"
              label={pt('resume.fromStart')}
              variant="secondary"
              onPress={() => controller.chooseStart(false)}
            />
          </FocusGuide>
        </View>
      ) : !playing ? (
        <View testID="play-starting" style={[styles.fill, styles.centre, { gap: design.space.xl }]}>
          <View style={{ gap: design.space.xs, alignItems: 'center' }}>
            <Text variant="overline" tone="muted">
              {pt('stepper.title')}
            </Text>
            <Text variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
              {title}
            </Text>
          </View>
          <StartStepper playback={controller?.playback ?? null} states={controller?.states ?? []} />
        </View>
      ) : null}
      {!playing || failed ? (
        <View style={{ position: 'absolute', top, left: design.layout.gutter }}>
          <IconButton
            testID="play-close"
            icon={X}
            variant="ghost"
            accessibilityLabel={pt('controls.close')}
            hasTVPreferredFocus={!failed && phase !== 'resume'}
            onPress={close}
          />
        </View>
      ) : null}
      {phase === 'switching' ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.centre]}>
          <View
            style={{
              padding: design.space.lg,
              borderRadius: design.radius.lg,
              backgroundColor: colors.scrim.DEFAULT,
              gap: design.space.md,
            }}>
            <Text variant="callout">{pt('stepper.switching')}</Text>
            <StartStepper
              playback={controller?.playback ?? null}
              states={controller?.states ?? []}
            />
          </View>
        </View>
      ) : null}
      {notice ? (
        <View
          testID={`player-notice-${notice.kind}`}
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: top + design.px(design.isTV ? 70 : 56),
            alignSelf: 'center',
            maxWidth: design.px(640),
            paddingHorizontal: design.space.lg,
            paddingVertical: design.space.sm,
            borderRadius: design.radius.md,
            backgroundColor: colors.surface.overlay,
          }}>
          <Text variant="callout">
            {notice.kind === 'stepDown'
              ? pt('notice.stepDown', {
                  from: methodName(pt, notice.params?.from),
                  to: methodName(pt, notice.params?.to),
                })
              : pt('notice.switchFailed', {
                  reason: describeError(t, { code: notice.params?.code ?? 'unknown' }).message,
                })}
          </Text>
        </View>
      ) : null}
      {showUpNext && next ? (
        <UpNextCard next={next} onPlay={playNext} onCancel={() => setUpNextDismissedFor(workId)} />
      ) : null}
      {controller ? (
        <PlayerPanels
          panel={panel}
          onClose={() => setPanel(null)}
          controller={controller}
          title={title}
        />
      ) : null}
      <VersionPicker
        open={picker}
        onClose={() => setPicker(false)}
        workId={workId}
        title={title}
        currentReleaseId={controller?.playback?.version?.releaseId}
        onPlay={(version) => {
          setPicker(false);
          setReleaseId(version.releaseId ?? undefined);
          setAttempt((value) => value + 1);
        }}
      />
    </View>
  );
}

function methodName(pt: ReturnType<typeof usePlayerT>, method: string | undefined): string {
  return method === 'direct' || method === 'remux' || method === 'transcode'
    ? pt(`methods.${method}`)
    : (method ?? '');
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
});
