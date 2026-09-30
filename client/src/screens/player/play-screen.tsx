'use no memo';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pause, Play, X } from 'lucide-react-native';
import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { toAppError } from '@/api/errors';
import { invalidateWatchQueries } from '@/browse/queries';
import { CENTRED_ROW, FocusGuide, useBackHandler } from '@/components/focus';
import { ErrorState } from '@/components/states/error-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { loadDeviceCaps } from '@/player/device-profile';
import { nativeCandidates } from '@/player/engines';
import { useRemoteKeys } from '@/player/remote-keys';
import { PlayerSession } from '@/screens/dev-player/player-session';
import { colors, useDesign } from '@/theme';

type Params = {
  playbackId: string;
  workId?: string;
  releaseId?: string;
  start?: string;
  title?: string;
};

const STATES = ['queued', 'resolving', 'fallback', 'repairing', 'planning', 'starting'] as const;
type StartState = (typeof STATES)[number];

/** Player route: starts the playback through the M3.1 engine path (M4.2 replaces the UI). */
export function PlayScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const sessionRef = useRef<PlayerSession | null>(null);
  const workId = params.workId ?? '';
  const startSeconds = Number(params.start) || 0;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  useEffect(() => {
    if (!workId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    loadDeviceCaps()
      .then((caps) => {
        if (cancelled) return;
        const next = new PlayerSession({
          client,
          serverUrl: account.serverUrl,
          profile: caps.profile,
          caps: caps.report,
          nativeEngine: nativeCandidates()[0] ?? 'web',
          preferences: { engine: 'auto' },
          variant: {
            id: 'browse',
            label: params.title ?? workId,
            title: params.title ?? workId,
            workId,
            releaseId: params.releaseId || undefined,
          },
          startSeconds,
          diagnostics: false,
        });
        sessionRef.current = next;
        unsubscribe = next.onChange(refresh);
        setSession(next);
        void next.start();
      })
      .catch((error: unknown) => {
        if (!cancelled) setCapsError(toAppError(error).code);
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      const current = sessionRef.current;
      void current?.stop().finally(() => void invalidateWatchQueries(queryClient, account.id));
      sessionRef.current = null;
    };
    // A new attempt (retry) restarts the whole start flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, params.releaseId, attempt]);

  const engine = session?.engine;
  const Surface = session?.phase === 'playing' ? engine?.Surface : undefined;
  const snapshot = engine?.getSnapshot();
  const playing = snapshot?.state === 'playing' || snapshot?.state === 'buffering';
  const playback = session?.playback;
  const failed = session?.phase === 'failed' || !!capsError || !workId;
  const state = (STATES as readonly string[]).includes(playback?.state ?? '')
    ? (playback?.state as StartState)
    : 'queued';

  useRemoteKeys(session?.phase === 'playing', (action) => {
    if (action === 'toggle' || action === 'play' || action === 'pause') session?.togglePlay();
    else if (action === 'back10') session?.seekBy(-10);
    else if (action === 'forward30') session?.seekBy(30);
    else if (action === 'stop') close();
  });
  useBackHandler(() => {
    close();
    return true;
  });

  const code =
    capsError ?? playback?.error?.code ?? session?.error ?? (workId ? 'unknown' : 'not_found');

  return (
    <View
      testID={`play-screen-${params.playbackId}`}
      style={{ flex: 1, backgroundColor: colors.video }}>
      {Surface ? <Surface style={StyleSheet.absoluteFill} /> : null}
      {failed ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ErrorState
            testID="play-error"
            code={code}
            params={playback?.error?.params ?? undefined}
            actions={workId ? ['retry', 'back'] : ['back']}
            autoFocus
            onAction={(action) => {
              if (action === 'retry') {
                setCapsError(null);
                setSession(null);
                setAttempt((value) => value + 1);
              } else close();
            }}
          />
        </View>
      ) : session?.phase !== 'playing' ? (
        <View
          testID="play-starting"
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: design.space.md }}>
          <Spinner />
          <Text variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
            {params.title ?? ''}
          </Text>
          <Text testID="play-state" variant="body" tone="muted">
            {t(`player.states.${state}`)}
          </Text>
        </View>
      ) : null}
      <View
        style={{
          position: 'absolute',
          top: Math.max(insets.top, design.layout.edgeVertical),
          left: design.layout.gutter,
          right: design.layout.gutter,
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.md,
        }}>
        <FocusGuide
          remember
          trap={CENTRED_ROW}
          style={{ flexDirection: 'row', gap: design.space.sm }}>
          <IconButton
            testID="play-close"
            icon={X}
            accessibilityLabel={t('common.close')}
            hasTVPreferredFocus={!failed}
            onPress={close}
          />
          {session?.phase === 'playing' && !design.isTV ? (
            <IconButton
              testID="play-toggle"
              icon={playing ? Pause : Play}
              accessibilityLabel={t(playing ? 'player.pause' : 'player.play')}
              onPress={() => session.togglePlay()}
            />
          ) : null}
        </FocusGuide>
        {session?.phase === 'playing' ? (
          <Text testID="play-title" variant="subheading" numberOfLines={1} style={{ flex: 1 }}>
            {params.title ?? ''}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
