import {
  chooseDecoders,
  getDeviceProfileAsync,
  type DeviceProfile,
  type MediaCapsReport,
} from '@modules/media-caps';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { displayServerUrl } from '@/api/server-url';
import { platformKey } from '@/lib/platform';
import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ENGINE_LABELS, nativeCandidates, vlcAvailable, type EngineKind } from '@/player/engines';
import { colors, useDesign } from '@/theme';

import { loadVariantCases, type VariantCase } from './dev-world';
import { PlayerSession, type ResultRow } from './player-session';
import { PlayerView } from './player-view';

type Caps = { report: MediaCapsReport; profile: DeviceProfile };
type Preference = 'auto' | 'vlc';

const results: ResultRow[] = [];
const dash = (value: number | string | undefined | null) =>
  value === undefined || value === null || value === '' ? '–' : String(value);

function publish(extra: Record<string, unknown>): void {
  if (!__DEV__) return;
  const scope = globalThis as { __streamarrPlayer?: Record<string, unknown> };
  scope.__streamarrPlayer = { ...scope.__streamarrPlayer, results, ...extra };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const design = useDesign();
  return (
    <View style={{ gap: design.space.sm }}>
      <Text variant="heading">{title}</Text>
      {children}
    </View>
  );
}

function CapsSummary({ caps }: { caps: Caps }) {
  const { t } = useTranslation();
  const { report } = caps;
  const none = t('devPlayer.none');
  const list = (values: string[]) => (values.length ? values.join(', ') : none);
  return (
    <View testID="dev-player-caps">
      {chooseDecoders(report).map((choice) => (
        <View key={choice.codec}>
          <Text variant="callout">
            {t('devPlayer.codecLine', {
              codec: choice.codec,
              uses: choice.uses,
              height: choice.maxHeight ? String(choice.maxHeight) : 'none',
              depth: choice.maxBitDepth ?? 8,
              hdr: list(choice.hdrFormats),
            })}
          </Text>
          {choice.uses === 'none' ? null : (
            <Text variant="caption" tone="muted">
              {t('devPlayer.decoderNames', {
                hardware: list(choice.hardware),
                software: list(choice.software),
              })}
            </Text>
          )}
        </View>
      ))}
      <Text variant="callout">
        {t('devPlayer.display', {
          width: dash(report.display.width),
          height: dash(report.display.height),
          rate: report.display.refreshRate ? Math.round(report.display.refreshRate) : '–',
          hdr: list(report.display.hdrTypes),
        })}
      </Text>
      <Text variant="callout">
        {t('devPlayer.audioOutput', {
          channels: report.audioOutput.maxChannels,
          passthrough: list(report.audioOutput.passthrough),
          api: report.audioOutput.api,
        })}
      </Text>
      {report.web ? (
        <Text variant="callout">
          {t('devPlayer.web', {
            browser: report.web.browser,
            mse: String(report.web.mse || report.web.managedMse),
            hls: String(report.web.nativeHls),
          })}
        </Text>
      ) : null}
    </View>
  );
}

function resultLine(t: ReturnType<typeof useTranslation>['t'], row: ResultRow): string {
  return t('devPlayer.resultLine', {
    variant: row.variant,
    engine: row.engine ? ENGINE_LABELS[row.engine] : ENGINE_LABELS[row.candidate],
    method: dash(row.method),
    serverEngine: dash(row.serverEngine),
    api: dash(row.apiMs),
    ttff: dash(row.ttffMs),
    startup: dash(row.startupMs),
    seeks: row.seekMs.map(dash).join('/') || '–',
    rebuffers: row.rebuffers,
    dropped: dash(row.droppedFrames),
    decoder: `${dash(row.decoder)}${row.hardware === undefined ? '' : row.hardware ? ' (HW)' : ' (SW)'}`,
    video: dash(row.video),
    audio: row.audioTracks,
    subtitles: row.subtitleTracks,
    switches: row.switches.length ? row.switches.join(' ') : 'none',
    error: row.error ? row.error : 'none',
  });
}

/** `/dev/player`: plays every Dev World variant through the viewer playback API and measures the engines. */
export function DevPlayerScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { account, client } = useActiveAccount();
  const [caps, setCaps] = useState<Caps | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [cases, setCases] = useState<VariantCase[] | null>(null);
  const [casesError, setCasesError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<EngineKind>(nativeCandidates()[0]!);
  const [preference, setPreference] = useState<Preference>('auto');
  const [autoMeasure, setAutoMeasure] = useState(true);
  const [vlcDirect, setVlcDirect] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  const [rows, setRows] = useState<ResultRow[]>(() => [...results]);
  const batchCancelled = useRef(false);
  const sessionRef = useRef<PlayerSession | null>(null);

  useEffect(() => {
    getDeviceProfileAsync({ vlc: vlcAvailable() })
      .then((value) => {
        setCaps(value);
        publish({ caps: value.report, profile: value.profile });
      })
      .catch((error: Error) => setCapsError(error.message));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadVariantCases(account.serverUrl, controller.signal)
      .then(setCases)
      .catch((error: Error) => {
        if (!controller.signal.aborted) setCasesError(error.message);
      });
    return () => controller.abort();
  }, [account.serverUrl]);

  const finish = async (current: PlayerSession) => {
    await current.stop();
    const row = current.result();
    results.push(row);
    // Metro prints this line; the M3.1 comparison table is built from it.
    console.log(`[m31-result] ${JSON.stringify({ target: platformKey(), ...row })}`);
    setRows([...results]);
    publish({});
    if (sessionRef.current === current) {
      sessionRef.current = null;
      setSession(null);
    }
  };

  const run = async (
    variant: VariantCase,
    engine: EngineKind,
    measure: boolean,
    pref: Preference = preference
  ) => {
    if (!caps) return null;
    const next = new PlayerSession({
      client,
      serverUrl: account.serverUrl,
      profile: caps.profile,
      caps: caps.report,
      nativeEngine: engine,
      engineOptions: { vlc: { directRendering: vlcDirect } },
      preferences: { engine: pref },
      variant,
    });
    sessionRef.current = next;
    setSession(next);
    await next.start();
    if (measure) {
      setMeasuring(true);
      await next.bench();
      setMeasuring(false);
    }
    return next;
  };

  const runAll = async (
    engine: EngineKind = candidate,
    pref: Preference = preference,
    only?: string[]
  ) => {
    if (!cases) return;
    const list = only ? cases.filter((item) => only.includes(item.id)) : cases;
    batchCancelled.current = false;
    for (const [index, variant] of list.entries()) {
      if (batchCancelled.current) break;
      setBatch({ index: index + 1, total: list.length });
      const current = await run(variant, engine, true, pref);
      if (current) await finish(current);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    setBatch(null);
  };

  const exit = () => {
    batchCancelled.current = true;
    const current = sessionRef.current;
    if (current) void finish(current);
  };

  useEffect(() =>
    publish({
      runAll: (engine?: EngineKind, pref?: Preference, only?: string[]) =>
        void runAll(engine, pref, only),
      run: (id: string, engine?: EngineKind, pref?: Preference) => {
        const variant = cases?.find((item) => item.id === id);
        if (variant) void run(variant, engine ?? candidate, autoMeasure, pref);
      },
      stop: exit,
      cases: cases?.map((item) => item.id),
      session: () => sessionRef.current?.result(),
      current: () => sessionRef.current,
    })
  );

  useEffect(() => publish({ setVlcDirect, setAutoMeasure }), []);

  if (session)
    return (
      <PlayerView
        key={String(results.length)}
        session={session}
        measuring={measuring}
        onMeasure={() => {
          setMeasuring(true);
          void session.bench().finally(() => setMeasuring(false));
        }}
        onExit={exit}
      />
    );

  const engines = nativeCandidates();
  return (
    <View testID="dev-player-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: design.isTV ? design.layout.edgeVertical : insets.top + design.space.lg,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          paddingHorizontal: design.layout.gutter,
          gap: design.layout.sectionGap,
        }}>
        <View style={{ gap: design.space.xs }}>
          <Text variant="title">{t('devPlayer.title')}</Text>
          <Text variant="callout" tone="muted">
            {t('devPlayer.subtitle', {
              server: displayServerUrl(account.serverUrl),
              platform: caps?.report.platform ?? '…',
              model: [caps?.report.device.manufacturer, caps?.report.device.model]
                .filter(Boolean)
                .join(' '),
            })}
          </Text>
        </View>

        <Section title={t('devPlayer.capsTitle')}>
          {caps ? <CapsSummary caps={caps} /> : null}
          {!caps && !capsError ? <Text tone="muted">{t('devPlayer.capsLoading')}</Text> : null}
          {capsError ? (
            <Text tone="danger">{t('devPlayer.capsError', { message: capsError })}</Text>
          ) : null}
          {caps ? (
            <FocusGuide trap={END_OF_ROW} style={{ flexDirection: 'row' }}>
              <Button
                testID="dev-player-show-profile"
                variant="ghost"
                size="sm"
                label={t(showProfile ? 'devPlayer.hideProfile' : 'devPlayer.showProfile')}
                onPress={() => setShowProfile((value) => !value)}
              />
            </FocusGuide>
          ) : null}
          {caps && showProfile ? (
            <Text variant="caption" tone="muted" testID="dev-player-profile-json">
              {JSON.stringify(caps.profile)}
            </Text>
          ) : null}
        </Section>

        <Section title={t('devPlayer.engineTitle')}>
          <FocusGuide
            trap={END_OF_ROW}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
            {engines.map((engine, index) => (
              <Button
                key={engine}
                testID={`dev-player-engine-${engine}`}
                variant={engine === candidate ? 'primary' : 'secondary'}
                size="sm"
                label={ENGINE_LABELS[engine]}
                hasTVPreferredFocus={index === 0}
                onPress={() => setCandidate(engine)}
              />
            ))}
          </FocusGuide>
          {vlcAvailable() ? (
            <FocusGuide
              trap={END_OF_ROW}
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
              {(['auto', 'vlc'] as const).map((value) => (
                <Button
                  key={value}
                  testID={`dev-player-preference-${value}`}
                  variant={value === preference ? 'primary' : 'secondary'}
                  size="sm"
                  label={t(`devPlayer.preference.${value}`)}
                  onPress={() => setPreference(value)}
                />
              ))}
              <Button
                testID="dev-player-vlc-direct"
                variant="ghost"
                size="sm"
                label={t('devPlayer.vlcDirect', { state: vlcDirect ? 'on' : 'off' })}
                onPress={() => setVlcDirect((value) => !value)}
              />
            </FocusGuide>
          ) : null}
          <FocusGuide
            trap={END_OF_ROW}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
            <Button
              testID="dev-player-auto-measure"
              variant="ghost"
              size="sm"
              label={t('devPlayer.autoMeasure', { state: autoMeasure ? 'on' : 'off' })}
              onPress={() => setAutoMeasure((value) => !value)}
            />
            <Button
              testID="dev-player-run-all"
              variant="secondary"
              size="sm"
              disabled={!cases || !caps || !!batch}
              label={batch ? t('devPlayer.running', batch) : t('devPlayer.runAll')}
              onPress={() => void runAll()}
            />
          </FocusGuide>
        </Section>

        <Section title={t('devPlayer.variantsTitle')}>
          {!cases && !casesError ? (
            <Text tone="muted">{t('devPlayer.variantsLoading')}</Text>
          ) : null}
          {casesError ? (
            <Text tone="danger">{t('devPlayer.variantsError', { message: casesError })}</Text>
          ) : null}
          <View style={{ gap: design.space.xs, alignItems: 'flex-start' }}>
            {(cases ?? []).map((variant) => (
              <Button
                key={variant.id}
                testID={`dev-player-case-${variant.id}`}
                variant="secondary"
                size="sm"
                disabled={!caps}
                label={
                  variant.scenario
                    ? t(`devPlayer.scenario.${variant.scenario}`, { title: variant.title })
                    : t('devPlayer.variantLabel', { label: variant.label, title: variant.title })
                }
                onPress={() => void run(variant, candidate, autoMeasure)}
              />
            ))}
          </View>
        </Section>

        <Section title={t('devPlayer.resultsTitle')}>
          {rows.length === 0 ? <Text tone="muted">{t('devPlayer.resultsEmpty')}</Text> : null}
          {rows.map((row, index) => (
            <Text key={index} variant="caption" testID={`dev-player-result-${index}`}>
              {resultLine(t, row)}
            </Text>
          ))}
          {rows.length ? (
            <FocusGuide trap={END_OF_ROW} style={{ flexDirection: 'row' }}>
              <Button
                variant="ghost"
                size="sm"
                label={t('devPlayer.clearResults')}
                onPress={() => {
                  results.length = 0;
                  setRows([]);
                }}
              />
            </FocusGuide>
          ) : null}
        </Section>
      </ScrollView>
    </View>
  );
}
