'use no memo';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { Play, RotateCcw, X } from 'lucide-react-native';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Dimensions, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { invalidateWatchQueries } from '@/browse/queries';
import { VersionPicker } from '@/browse/version-picker';
import { CENTRED_ROW, FocusGuide, useBackHandler } from '@/components/focus';
import { Glass, GlassButton } from '@/components/glass';
import { ErrorState, type ErrorAction } from '@/components/states/error-state';
import { Text } from '@/components/ui/text';
import { detailHref, isDetailOf, openerLeaf, playHref } from '@/navigation/routes';
import { useScreenTitle } from '@/navigation/screen-title';
import { PlaybackController } from '@/player/controller';
import { loadDeviceCaps } from '@/player/device-profile';
import { endOverlay } from '@/player/end-state';
import { nativeCandidates } from '@/player/engines';
import { lockPlayerLandscape } from '@/player/orientation';
import { clock } from '@/player/format';
import { stepDownKey } from '@/player/overlay-labels';
import type { PlaybackPreferences } from '@/player/playback-api';
import { useClock } from '@/player/use-clock';
import { usePlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign, useFocusGap } from '@/theme';

import { PlayerOverlay } from './player-overlay';
import { PlayerPanels, type PanelKind } from './player-panels';
import { PlayerCard, PlayerCardTitle, StartStepper } from './start-stepper';
import { EndCard, UpNextCard, useNextEpisode } from './up-next';

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

const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

/** Player route: start flow with the stepper, resume choice, overlay, panels, up-next and errors. */
export function PlayScreen() {
  const pt = usePlayerT();
  const { t } = useTranslation();
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
  const close = () => {
    leaving.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const backToDetails = () => {
    const href = detailHref(workId);
    if (!href || isDetailOf(openerLeaf(navigation.getState()), workId)) close();
    else router.replace(href);
  };

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
    const { width, height } = Dimensions.get('window');
    // Loaded lazily: expo-screen-orientation has no tvOS native module.
    return lockPlayerLandscape(import('expo-screen-orientation'), height > width);
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

  const onBack = () => {
    if (picker) setPicker(false);
    else if (panel) setPanel(null);
    else if (showUpNext) setUpNextDismissedFor(workId);
    else if (showEndCard) close();
    else if (!(playing && overlayBack.current?.())) close();
    return true;
  };
  useBackHandler(onBack);
  // tvOS pops the native stack on Menu before JS sees it; preventing that routes Menu through onBack.
  usePreventRemove(APPLE_TV, ({ data }) => {
    const back = data.action.type === 'POP' || data.action.type === 'GO_BACK';
    if (leaving.current || !back) navigation.dispatch(data.action);
    else onBack();
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
          suspended={panel !== null || picker || showUpNext || showEndCard}
          ended={showEndCard}
          onPanel={setPanel}
          panel={panel}
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
              actions={workId ? actions : ['back']}
              autoFocus={!picker}
              onAction={onFailureAction}
            />
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
        <View testID="play-starting" style={[styles.fill, styles.centre, { gap: design.space.xl }]}>
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
          </PlayerCard>
        </View>
      ) : null}
      {notice && !pip ? (
        <Glass
          testID={`player-notice-${notice.kind}`}
          pointerEvents="none"
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
            {notice.kind === 'stepDown'
              ? pt(stepDownKey(notice.params))
              : pt('notice.switchFailed', {
                  reason: describeError(t, { code: notice.params?.code ?? 'unknown' }).message,
                })}
          </Text>
        </Glass>
      ) : null}
      {showUpNext && next ? (
        <UpNextCard next={next} onPlay={playNext} onCancel={() => setUpNextDismissedFor(workId)} />
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
  );
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
});
