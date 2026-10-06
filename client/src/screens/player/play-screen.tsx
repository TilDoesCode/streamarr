'use no memo';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { Play, RotateCcw, X } from '@/components/icons';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Dimensions, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { parseEndedReason } from '@/accounts/ended-reason';
import { holdForPlayer } from '@/accounts/player-hold';
import { describeError } from '@/api/error-text';
import { languageName } from '@/browse/version-format';
import { invalidateWatchQueries } from '@/browse/queries';
import { VersionPicker } from '@/browse/version-picker';
import { CENTRED_ROW, FocusGuide } from '@/components/focus';
import { Glass, GlassButton } from '@/components/glass';
import { ErrorState, type ErrorAction } from '@/components/states/error-state';
import { Text } from '@/components/ui/text';
import { detailHref, isDetailOf, openerLeaf, playHref } from '@/navigation/routes';
import { useScreenTitle } from '@/navigation/screen-title';

import { leavePlayer, useHintDismiss, usePlayerBack } from './player-tv-back';
import { rememberedAudioLanguage } from '@/player/audio-preference';
import { PlaybackController } from '@/player/controller';
import { loadDeviceCaps } from '@/player/device-profile';
import { endOverlay } from '@/player/end-state';
import { nativeCandidates, vlcAvailable } from '@/player/engines';
import { exitPlayerFullscreen } from '@/player/fullscreen';
import { createPlayer } from '@/player/caps-fallback';
import { lockPlayerLandscape } from '@/player/orientation';
import { clock } from '@/player/format';
import { noticeMs, noticeText, subtitleLabel } from '@/player/overlay-labels';
import type { PlaybackPreferences } from '@/player/playback-api';
import { usePlayerClock } from '@/player/use-clock';
import { useCloseOnFailure } from './use-close-on-failure';
import { hintText, type HintAction } from '@/player/recovery/hints';
import { usePlayerT } from '@/player/use-player-t';
import { isPlayingHere, useOneTabPlays } from '@/player/tab-guard';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign, useFocusGap } from '@/theme';

import { PlayerOverlay } from './player-overlay';
import { PlayerPanels, type PanelKind } from './player-panels';
import { cardButtons, failureReason } from './card-actions';
import { PlayerStatusView, RecoveryLog } from './player-status';
import { PlayerCard, PlayerCardTitle, StartStepper } from './start-stepper';
import { EndCard, UpNextCard, useNextEpisode } from './up-next';
import { useCloseAfterFrame } from './closing';
import { StatusAction } from './status-action';
import { LoaderMotionContext } from '@/components/ui/loader-motion';

type Params = {
  playbackId: string;
  workId?: string;
  releaseId?: string;
  start?: string;
  title?: string;
};

const UP_NEXT_SECONDS = 15;

const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

/** Player route: start flow with the stepper, resume choice, overlay, panels, up-next and errors. */
export function PlayScreen() {
  const pt = usePlayerT();
  const { t, i18n } = useTranslation();
  const untypedT = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const design = useDesign();
  const resumeGap = useFocusGap(design.space.md);
  const { large } = useShell();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  useScreenTitle(params.title);
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const [controller, setController] = useState<PlaybackController | null>(null);
  // The session may end while playing: the screen stays and the card says why (S9b A05).
  useEffect(() => holdForPlayer(account.id), [account.id]);
  useEffect(() => {
    if (!account.signedIn)
      controller?.endSession(parseEndedReason(account.endedReason ?? 'refresh_session_expired'));
  }, [controller, account.signedIn, account.endedReason]);
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
  const leaving = useRef(false);
  // Loaders stop one render before the player's screen goes (F12-1); the navigation follows a frame later.
  const { closing, closeAfterFrame } = useCloseAfterFrame();
  const close = () => {
    leaving.current = true;
    const opener = openerLeaf(navigation.getState());
    closeAfterFrame(() => leavePlayer(router, { detail: detailHref(workId), opener }));
  };
  const backToDetails = () => {
    const href = detailHref(workId);
    if (!href || isDetailOf(openerLeaf(navigation.getState()), workId)) return close();
    leaving.current = true;
    closeAfterFrame(() => router.replace(href));
  };

  useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getVersion ?? zero,
    controller?.getVersion ?? zero
  );
  // Web: one playing tab per browser; a start in another tab pauses this one (F12).
  useOneTabPlays(isPlayingHere(controller), () => controller?.yieldToOtherTab());
  const { clock: clockState, onVisibleChange: setOverlayShown } = usePlayerClock(
    controller?.engine,
    panel !== null
  );
  const next = useNextEpisode(workId);

  useEffect(() => {
    if (!workId) return;
    let cancelled = false;
    let current: PlaybackController | null = null;
    createPlayer(loadDeviceCaps, (profile) => {
      if (cancelled) return null;
      current = new PlaybackController({
        client,
        accountId: account.id,
        serverUrl: account.serverUrl,
        profile,
        nativeEngine: nativeCandidates()[0] ?? 'web',
        workId,
        releaseId,
        startSeconds,
        preferences: { audioLanguage: rememberedAudioLanguage(account.id), ...preferences },
      });
      setController(current);
      if (__DEV__) (globalThis as { __streamarrPlayer?: unknown }).__streamarrPlayer = current;
      return current;
    }).catch((error: unknown) => {
      // Anything else that breaks before the start is the app's own fault: its own text, never the generic one (E16).
      if (__DEV__) console.warn('[player] start failed', error);
      if (!cancelled) setCapsError('player_internal_error');
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
    const { width, height } = Dimensions.get('window');
    // Loaded lazily: expo-screen-orientation has no tvOS native module.
    return lockPlayerLandscape(import('expo-screen-orientation'), height > width);
  }, [design.formFactor]);

  useEffect(() => exitPlayerFullscreen, []);

  const notice = controller?.notice;
  // Subtitles kept off for this video (failed twice): touch and web get the way back on (S4p R1; TV uses the panel).
  const keptOff =
    !design.isTV && notice?.kind === 'subtitleFailed' && !notice.params?.retry
      ? Number(notice.params?.index)
      : null;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => controller?.dismissNotice(), noticeMs(design.isTV));
    return () => clearTimeout(timer);
  }, [notice, controller, design.isTV]);

  const phase = controller?.phase ?? 'starting';
  const failed = phase === 'failed' || !!capsError || !workId;
  useCloseOnFailure(failed, () => {
    setPanel(null);
    setPicker(false);
  });
  const [controlsShown, setControlsShown] = useState(true);
  const playing = phase === 'playing' || phase === 'switching';
  const remaining = (clockState.duration || 0) - clockState.position;
  const endState = endOverlay({
    playing,
    ended: !!controller?.ended,
    hasNext: !!next,
    upNextDismissed: upNextDismissedFor === workId,
    blocked: panel !== null || picker,
    remaining,
    duration: clockState.duration,
    upNextSeconds: UP_NEXT_SECONDS,
  });
  const pip = !!controller?.pictureInPicture;
  const showUpNext = endState === 'upNext' && !pip;
  const showEndCard = endState === 'endCard' && !pip;

  const playNext = () => {
    if (!next) return;
    router.replace(playHref({ workId: next.workId, title: next.playTitle, startSeconds: 0 }));
  };

  const hintDismiss = useHintDismiss(controller?.status.hint?.key ?? null);
  const onBack = () => {
    const recovering = playing && !!controller?.status.spinner && !!controller.status.hint;
    if (picker) setPicker(false);
    else if (panel) setPanel(null);
    else if (showUpNext) setUpNextDismissedFor(workId);
    else if (showEndCard) close();
    else if (playing && overlayBack.current?.()) return true;
    else if (hintDismiss.back(recovering) === 'leave') close();
    return true;
  };
  usePlayerBack(onBack);
  // tvOS pops the native stack on Menu before JS sees it; preventing that routes Menu through onBack.
  usePreventRemove(APPLE_TV, ({ data }) => {
    const back = data.action.type === 'POP' || data.action.type === 'GO_BACK';
    if (leaving.current || !back) navigation.dispatch(data.action);
    else onBack();
  });

  const onFailureAction = (action: ErrorAction) => {
    setCapsError(null);
    // A playback that ran resumes at its last good position in place; a failed start starts over.
    if (action === 'retry' && controller?.retry()) return;
    if (action === 'retry') setAttempt((value) => value + 1);
    else if (action === 'otherVersion') setPicker(true);
    else if (action === 'lowerQuality') setPreferences((value) => ({ ...value, maxHeight: 720 }));
    else if (action === 'useVlc') setPreferences((value) => ({ ...value, engine: 'vlc' }));
    else if (action === 'signIn') {
      // Signed out mid-play: the position is saved (queued reports); the account screen signs in again.
      leaving.current = true;
      closeAfterFrame(() => router.replace('/profiles'));
    } else close();
  };

  const onStatusAction = (action: HintAction) => {
    if (!controller) return;
    if (action === 'resume' || action === 'play') controller.setPaused(false);
    else if (action === 'unmute') controller.unmute();
    else if (action === 'tryNow') controller.recoverNow();
    else if (action === 'lowerQuality') void controller.lowerQuality();
    else if (action === 'otherVersion') setPicker(true);
    else if (action === 'otherAudio') setPanel('audio');
    else if (action === 'otherSubtitles') setPanel('subtitles');
    else close();
  };
  const status = controller?.status;

  const failure = controller?.failure;
  const code = capsError ?? failure?.code ?? (workId ? 'unknown' : 'not_found');
  const actions = cardButtons(failure?.actions, { vlc: vlcAvailable() });
  const reason = failureReason(untypedT, failure?.params, (key) =>
    i18n.exists(`errors.reasons.${key}`)
  );
  const top = Math.max(insets.top, design.layout.edgeVertical);

  return (
    <LoaderMotionContext value={!closing}>
      <View
        testID={`play-screen-${params.playbackId}`}
        style={{ flex: 1, backgroundColor: colors.video }}>
        {controller && playing ? (
          <PlayerOverlay
            controller={controller}
            clock={clockState}
            title={title}
            suspended={panel !== null || picker || showUpNext || showEndCard}
            ended={showEndCard}
            onPanel={setPanel}
            panel={panel}
            onClose={close}
            backRef={overlayBack}
            onVisibleChange={(visible) => {
              setOverlayShown(visible);
              setControlsShown(visible);
            }}
          />
        ) : null}
        {controller &&
        playing &&
        status &&
        !pip &&
        !showEndCard &&
        // A viewer's switch shows its explanation in the switching card; running steps keep their spinner and hint.
        (phase !== 'switching' || status.spinner) ? (
          <PlayerStatusView
            status={hintDismiss.hidden ? { ...status, hint: null } : status}
            onAction={onStatusAction}
            controlsVisible={controlsShown}
            top={top + design.px(design.isTV ? 70 : 56)}
            noticeShown={!!notice && !pip}
          />
        ) : null}
        {failed ? (
          <ScrollView
            contentContainerStyle={[
              styles.centre,
              { padding: design.layout.gutter, gap: design.space.xl },
            ]}>
            <PlayerCard testID="play-error-card" width={900}>
              <View style={{ gap: design.space.xs, alignItems: 'center' }}>
                <Text variant="overline" tone="muted">
                  {pt('stepper.failed')}
                </Text>
                {title ? <PlayerCardTitle>{title}</PlayerCardTitle> : null}
              </View>
              {controller?.states.length ? (
                <StartStepper playback={controller.playback} states={controller.states} failed />
              ) : null}
              <ErrorState
                testID="play-error"
                compact
                code={code}
                params={failure?.params}
                status={failure?.status}
                actions={workId ? actions : ['back']}
                autoFocus={!picker}
                onAction={onFailureAction}
              />
              {reason ? (
                <Text testID="play-error-reason" variant="callout" tone="muted">
                  {reason}
                </Text>
              ) : null}
              {failure?.hint ? (
                <Text testID="play-error-hint" variant="callout" style={{ textAlign: 'center' }}>
                  {hintText(pt, failure.hint.key, failure.hint.params)}
                </Text>
              ) : null}
              {failure?.tried?.length ? <RecoveryLog tried={failure.tried} /> : null}
            </PlayerCard>
          </ScrollView>
        ) : phase === 'resume' && controller ? (
          <View testID="play-resume" style={[styles.fill, styles.centre, { gap: design.space.lg }]}>
            <PlayerCard>
              <Text variant="overline" tone="muted">
                {title}
              </Text>
              <PlayerCardTitle>{pt('resume.title')}</PlayerCardTitle>
              <FocusGuide trap={CENTRED_ROW} style={{ flexDirection: 'row', gap: resumeGap }}>
                <GlassButton
                  testID="play-resume-yes"
                  tone="solid"
                  icon={Play}
                  label={pt('resume.resume', { time: clock(controller.resumeSeconds) })}
                  hasTVPreferredFocus
                  onPress={() => controller.chooseStart(true)}
                />
                <GlassButton
                  testID="play-resume-no"
                  icon={RotateCcw}
                  label={pt('resume.fromStart')}
                  onPress={() => controller.chooseStart(false)}
                />
              </FocusGuide>
            </PlayerCard>
          </View>
        ) : !playing ? (
          <View
            testID="play-starting"
            style={[styles.fill, styles.centre, { gap: design.space.xl }]}>
            <PlayerCard testID="play-starting-card">
              <View style={{ gap: design.space.xs, alignItems: 'center' }}>
                <Text variant="overline" tone="muted">
                  {pt('stepper.title')}
                </Text>
                <PlayerCardTitle>{title}</PlayerCardTitle>
              </View>
              <StartStepper
                playback={controller?.playback ?? null}
                states={controller?.states ?? []}
              />
              {status?.hint ? (
                <Text testID={`play-starting-${status.hint.key}`} variant="callout" tone="muted">
                  {hintText(pt, status.hint.key, status.hint.params)}
                </Text>
              ) : null}
            </PlayerCard>
          </View>
        ) : null}
        {/* TV: a failed start offers Zurück in the card; a corner X there would hold focus out of the card's reach. */}
        {(!playing || failed) && !(failed && design.isTV) ? (
          <View style={{ position: 'absolute', top, left: design.layout.gutter }}>
            <GlassButton
              testID="play-close"
              iconOnly
              icon={X}
              label={pt('controls.close')}
              hasTVPreferredFocus={!failed && phase !== 'resume'}
              onPress={close}
            />
          </View>
        ) : null}
        {phase === 'switching' ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.centre]}>
            <PlayerCard testID="play-switching" width={640}>
              <Text variant="callout">{pt('stepper.switching')}</Text>
              <StartStepper
                playback={controller?.playback ?? null}
                states={controller?.states ?? []}
              />
              {status?.hint && !status.spinner ? (
                <Text testID={`play-switching-${status.hint.key}`} variant="callout" tone="muted">
                  {hintText(pt, status.hint.key, status.hint.params)}
                </Text>
              ) : null}
            </PlayerCard>
          </View>
        ) : null}
        {notice && !pip ? (
          <Glass
            testID={`player-notice-${notice.kind}`}
            pointerEvents={keptOff !== null ? 'box-none' : 'none'}
            style={{
              position: 'absolute',
              top: top + design.px(design.isTV ? 70 : 56),
              alignSelf: 'center',
              maxWidth: design.px(640),
              paddingHorizontal: design.space.lg,
              paddingVertical: design.space.sm,
            }}
            intensity="strong"
            radius={design.radius.md}>
            <Text variant="callout">
              {noticeText(
                notice,
                pt,
                (error) => describeError(t, error).message,
                (index) => {
                  const tracks = controller?.playback?.mediaInfo?.subtitleTracks ?? [];
                  const track = tracks.find((item) => item.index === index);
                  return track
                    ? subtitleLabel(
                        track,
                        tracks,
                        (code) => languageName(code, i18n.language, t),
                        ''
                      )
                    : pt('trackFallback', { index });
                }
              )}
            </Text>
            {keptOff !== null ? (
              <StatusAction
                testID="player-notice-subtitles-on"
                primary
                label={pt('notice.subtitlesOn')}
                onPress={() => {
                  const track = controller?.playback?.mediaInfo?.subtitleTracks?.find(
                    (item) => item.index === keptOff
                  );
                  controller?.dismissNotice();
                  if (track) void controller?.selectSubtitle(track);
                }}
              />
            ) : null}
          </Glass>
        ) : null}
        {showUpNext && next ? (
          <UpNextCard
            next={next}
            paused={!!controller?.paused}
            onPlay={playNext}
            onCancel={() => setUpNextDismissedFor(workId)}
          />
        ) : null}
        {showEndCard && controller ? (
          <EndCard
            title={title}
            next={next}
            onReplay={() => controller.replay()}
            onBack={backToDetails}
            onNext={playNext}
          />
        ) : null}
        {controller ? (
          <PlayerPanels
            panel={panel}
            onClose={() => setPanel(null)}
            controller={controller}
            title={title}
            glass={large}
            clock={clockState}
            onPanel={setPanel}
            onBack={onBack}
          />
        ) : null}
        <VersionPicker
          open={picker}
          onClose={() => setPicker(false)}
          workId={workId}
          title={title}
          currentReleaseId={controller?.playback?.version?.releaseId}
          glass={large}
          onPlay={(version) => {
            setPicker(false);
            setReleaseId(version.releaseId ?? undefined);
            setAttempt((value) => value + 1);
          }}
        />
      </View>
    </LoaderMotionContext>
  );
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
});
