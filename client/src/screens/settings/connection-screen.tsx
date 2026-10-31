import { Stack } from 'expo-router';
import { Check, RefreshCw, X } from '@/components/icons';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeError } from '@/api/error-text';
import { isAppError } from '@/api/errors';
import { FocusLift, FocusSection, Focusable } from '@/components/focus';
import { SettingsButtonRow, SettingsSection } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { FormMessage, type FormMessageTone } from '@/components/ui/form-message';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  latencyWarning,
  QUALITY_TIERS,
  tierPasses,
  verdictFor,
  type SpeedProgress,
  type SpeedResult,
  type SpeedVerdict,
} from '@/diagnostics/speed-test';
import { ServiceVerdict, useServiceStatusView } from '@/diagnostics/service-status-ui';
import { useActiveAccount } from '@/accounts/accounts-provider';
import { useDeviceBandwidth } from '@/diagnostics/device-bandwidth';
import {
  measureAllLabel,
  measuredAgo,
  StreamingPathCard,
  usePathMeasurement,
} from '@/diagnostics/streaming-path-ui';
import {
  useServerDiagnostics,
  useSpeedTest,
  type DiagnosticsComponent,
  type DiagnosticsReport,
} from '@/diagnostics/use-diagnostics';
import { formatDuration } from '@/i18n/format';
import { BackControl } from '@/navigation/back-control';
import { useScreenTitle } from '@/navigation/screen-title';
import { useShell } from '@/shell/use-shell';
import { colors, gutterPadding, useDesign } from '@/theme';

const VERDICT_TONE: Record<SpeedVerdict, FormMessageTone> = {
  uhdRemux: 'success',
  uhd: 'success',
  fhd: 'info',
  hd: 'warning',
  tooSlow: 'danger',
};

const REPORT_TONE: Record<string, FormMessageTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
};

const HINTS = [
  'database_unreachable',
  'no_providers',
  'all_providers_down',
  'provider_auth_failed',
  'some_providers_down',
  'provider_slow',
  'no_indexers',
  'all_indexers_down',
  'indexer_auth_failed',
  'some_indexers_down',
  'indexer_slow',
  'tmdb_unreachable',
  'tmdb_not_configured',
  'tmdb_slow',
  'disk_low',
  'connections_exhausted',
] as const;
const ERROR_CODES = [
  'timeout',
  'auth_failed',
  'unreachable',
  'http_error',
  'invalid_response',
  'not_configured',
  'slow',
  'low_space',
  'exhausted',
  'circuit_open',
] as const;
const COMPONENT_STATUSES = ['ok', 'degraded', 'down', 'unconfigured'] as const;

function oneOf<T extends string>(
  list: readonly T[],
  value: string | null | undefined
): T | undefined {
  return list.find((item) => item === value);
}

const STATUS_COLOR: Record<string, string> = {
  ok: colors.success.DEFAULT,
  degraded: colors.warning.DEFAULT,
  down: colors.danger.DEFAULT,
  unconfigured: colors.foreground.subtle,
};

function useNumber() {
  const { i18n } = useTranslation();
  return (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(
      value
    );
}

/** Settings → Connection & diagnostics: the streaming path (Usenet → server → device), a speed test to the server and the server's own dependency checks. */
export function ConnectionScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const shell = useShell();
  const insets = useSafeAreaInsets();
  const title = t('settings.connection.title');
  useScreenTitle(title);
  const pageHeading = design.isTV || Platform.OS === 'web' || shell.large;
  const speed = useSpeedTest();
  const path = usePathMeasurement(speed);
  const diagnostics = useServerDiagnostics();
  const verdict = useServiceStatusView().kind;
  const scroll = useRef<ScrollView>(null);
  const pathY = useRef(0);
  // The verdict's "Measure everything" hands over to the streaming path card (focus + scroll) and starts it there.
  const [handoff, setHandoff] = useState(false);
  const offered = verdict === 'ok' && !handoff && speed.state.status === 'idle' && !path.busy;
  const startFromVerdict = () => {
    setHandoff(true);
    if (Platform.OS !== 'web') scroll.current?.scrollTo({ y: pathY.current, animated: true });
    void path.measureAll();
  };
  return (
    <ScrollView
      ref={scroll}
      testID="connection-screen"
      style={{ flex: 1 }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingTop: pageHeading ? design.layout.edgeVertical + insets.top : design.space.lg,
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        ...gutterPadding(design),
        gap: design.layout.sectionGap,
        width: '100%',
        maxWidth: shell.large ? shell.s(1280) : design.layout.maxContentWidth,
      }}
      snapToAlignment={design.isTV ? 'item' : undefined}
      snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
      <Stack.Screen options={{ headerShown: !pageHeading, title }} />
      <View style={{ gap: design.space.xs }}>
        {pageHeading ? (
          <BackControl floating={false} style={{ marginBottom: design.space.md }} />
        ) : null}
        {pageHeading ? (
          <Text variant="title" role="heading" style={shell.large ? shell.pageTitle : undefined}>
            {title}
          </Text>
        ) : null}
        <Text variant="callout" tone="muted">
          {t('settings.connection.intro')}
        </Text>
      </View>
      <FocusSection testID="connection-verdict" pageTop>
        <ServiceVerdict
          preferFocus
          speedTestOffered={offered}
          speedTestLabel={measureAllLabel(t, path.allowed)}
          checking={diagnostics.refresh.isPending}
          onSpeedTest={startFromVerdict}
          onCheckAgain={() => diagnostics.refresh.mutate()}
        />
      </FocusSection>
      <View onLayout={(event) => (pathY.current = event.nativeEvent.layout.y)}>
        <StreamingPathCard
          path={path}
          allShown={!offered}
          preferFocus={verdict === 'unknown' || handoff}
        />
      </View>
      <SpeedDetailsSection speed={speed} />
      <ServerSection
        diagnostics={diagnostics}
        refreshable={verdict === 'ok' || verdict === 'unknown'}
      />
    </ScrollView>
  );
}

/** The last device measurement in detail (ping, jitter, download, upload, what it carries); the measuring itself is the streaming path card's. */
function SpeedDetailsSection({ speed }: { speed: ReturnType<typeof useSpeedTest> }) {
  const { t } = useTranslation();
  const design = useDesign();
  const number = useNumber();
  const { account } = useActiveAccount();
  const stored = useDeviceBandwidth(account.serverUrl);
  const { state } = speed;
  const running = state.status === 'running';
  const progress: SpeedProgress | undefined =
    state.status === 'running' ? state.progress : undefined;
  const result: SpeedResult | undefined =
    state.status === 'done'
      ? state.result
      : stored
        ? {
            downloadMbps: stored.downloadMbps,
            uploadMbps: stored.uploadMbps ?? 0,
            pingMs: stored.pingMs ?? 0,
            jitterMs: stored.jitterMs ?? 0,
          }
        : undefined;
  const mbps = (value?: number) =>
    value === undefined || value <= 0
      ? t('settings.connection.speed.none')
      : value >= 1000
        ? t('settings.connection.speed.gbps', { value: number(value / 1000) })
        : t('settings.connection.speed.mbps', { value: number(value) });
  const ms = (value?: number) =>
    value === undefined
      ? t('settings.connection.speed.none')
      : t('settings.connection.speed.ms', { value: number(value) });
  const shown = running ? progress : result;
  const live =
    running && progress?.liveMbps !== undefined && progress.phase !== 'ping'
      ? progress.liveMbps
      : undefined;
  return (
    <SettingsSection plain title={t('settings.connection.speed.title')} testID="connection-speed">
      {running ? (
        <View testID="connection-speed-running" style={{ gap: design.space.sm }}>
          <Text testID="connection-speed-phase" variant="callout" tone="muted">
            {t(`settings.connection.speed.phase.${progress?.phase ?? 'ping'}`)}
          </Text>
          <Text testID="connection-speed-live" variant="display">
            {live === undefined ? t('settings.connection.speed.none') : mbps(live)}
          </Text>
          <ProgressBar value={progress?.fraction ?? 0} size="md" />
        </View>
      ) : null}
      {!running && !result ? (
        <Text testID="connection-speed-empty" variant="callout" tone="muted">
          {t('settings.connection.speed.notMeasured')}
        </Text>
      ) : null}
      {!running && result && stored && state.status !== 'done' ? (
        <Text testID="connection-speed-measured" variant="caption" tone="muted">
          {t('settings.connection.speed.measuredAt', { ago: measuredAgo(t, stored.measuredAt) })}
        </Text>
      ) : null}
      {shown ? (
        <View
          testID="connection-speed-metrics"
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.lg }}>
          <Metric
            testID="connection-speed-ping"
            label={t('settings.connection.speed.ping')}
            value={ms(shown.pingMs)}
          />
          <Metric
            testID="connection-speed-jitter"
            label={t('settings.connection.speed.jitter')}
            value={ms(shown.jitterMs)}
          />
          <Metric
            testID="connection-speed-download"
            label={t('settings.connection.speed.download')}
            value={mbps(shown.downloadMbps)}
          />
          <Metric
            testID="connection-speed-upload"
            label={t('settings.connection.speed.upload')}
            value={mbps(shown.uploadMbps)}
          />
        </View>
      ) : null}
      {result && !running ? <SpeedVerdictView result={result} /> : null}
      <Text variant="caption" tone="muted">
        {t('settings.connection.speed.assumptions')}
      </Text>
    </SettingsSection>
  );
}

function Metric({ label, value, testID }: { label: string; value: string; testID: string }) {
  const design = useDesign();
  return (
    <View
      style={{ flexGrow: 1, flexBasis: '20%', minWidth: design.px(120), gap: design.space.xxs }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text testID={testID} variant="heading">
        {value}
      </Text>
    </View>
  );
}

function SpeedVerdictView({ result }: { result: SpeedResult }) {
  const { t } = useTranslation();
  const design = useDesign();
  const number = useNumber();
  const verdict = verdictFor(result.downloadMbps);
  const slowReplies = latencyWarning(result);
  return (
    <View style={{ gap: design.space.md }}>
      <FormMessage
        testID="connection-speed-verdict"
        tone={VERDICT_TONE[verdict]}
        title={t(`settings.connection.speed.verdict.${verdict}.title`)}
        message={t(`settings.connection.speed.verdict.${verdict}.message`)}
      />
      {slowReplies ? (
        <FormMessage
          testID="connection-speed-latency"
          tone="warning"
          title={t('settings.connection.speed.latencyTitle')}
          message={t('settings.connection.speed.latency', {
            ping: number(result.pingMs),
            jitter: number(result.jitterMs),
          })}
        />
      ) : null}
      <View testID="connection-speed-tiers" style={{ gap: design.space.xs }}>
        {QUALITY_TIERS.map((tier) => {
          const passes = tierPasses(tier.id, result.downloadMbps);
          const Icon = passes ? Check : X;
          return (
            <View
              key={tier.id}
              testID={`connection-tier-${tier.id}`}
              aria-label={`${t(`settings.connection.speed.tiers.${tier.id}`)}: ${t(passes ? 'settings.connection.speed.tierOk' : 'settings.connection.speed.tierNo')}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
              <Icon
                size={design.layout.iconSize.sm}
                color={passes ? colors.success.DEFAULT : colors.foreground.subtle}
                strokeWidth={2.5}
              />
              <Text variant="body" tone={passes ? 'default' : 'muted'}>
                {t(`settings.connection.speed.tiers.${tier.id}`)}
              </Text>
              <Text variant="caption" tone="muted">
                {t('settings.connection.speed.tierNeeds', { mbps: tier.mbps })}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ServerSection({
  diagnostics,
  refreshable,
}: {
  diagnostics: ReturnType<typeof useServerDiagnostics>;
  /** Off while the verdict above offers its own check again. */
  refreshable: boolean;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const { query, refresh } = diagnostics;
  const report = refresh.data ?? query.data;
  const error = query.error ?? refresh.error;
  return (
    <SettingsSection plain title={t('settings.connection.server.title')} testID="connection-server">
      {refreshable ? (
        <SettingsButtonRow>
          <Button
            testID="connection-server-refresh"
            variant="secondary"
            icon={RefreshCw}
            loading={refresh.isPending || query.isFetching}
            label={t('settings.connection.server.refresh')}
            onPress={() => refresh.mutate()}
          />
        </SettingsButtonRow>
      ) : null}
      {report ? (
        <Report report={report} />
      ) : error ? null : (
        <View testID="connection-server-loading" style={{ gap: design.space.sm }}>
          <SkeletonText width="60%" />
          <SkeletonText width="40%" />
          <SkeletonText width="50%" />
        </View>
      )}
      {error && !report ? (
        <FormMessage
          testID="connection-server-error"
          title={t('settings.connection.server.error')}
          message={isAppError(error) ? describeError(t, error).message : undefined}
        />
      ) : null}
    </SettingsSection>
  );
}

function Report({ report }: { report: DiagnosticsReport }) {
  const { t } = useTranslation();
  const design = useDesign();
  const hints = (report.hints ?? []).flatMap((hint) => {
    const known = oneOf(HINTS, hint);
    return known ? [t(`settings.connection.server.hints.${known}`)] : [];
  });
  const [first, ...rest] = hints;
  return (
    <View style={{ gap: design.space.lg }}>
      <FormMessage
        testID="connection-server-status"
        tone={REPORT_TONE[report.status ?? ''] ?? 'info'}
        title={t(`settings.connection.server.status.${statusKey(report.status)}`)}
        message={first}
      />
      {rest.length ? (
        <View testID="connection-server-hints" style={{ gap: design.space.xs }}>
          {rest.map((hint) => (
            <Text key={hint} variant="callout" tone="muted">
              {hint}
            </Text>
          ))}
        </View>
      ) : null}
      <View testID="connection-components" style={{ gap: design.space.xs }}>
        {(report.components ?? []).map((component) => (
          <ComponentRow key={component.id} component={component} />
        ))}
      </View>
      <Text testID="connection-server-footer" variant="caption" tone="muted">
        {t('settings.connection.server.footer', {
          version: (report.server.version ?? '').split('+')[0],
          uptime: formatDuration(report.server.uptimeSeconds, t),
          seconds: Math.round(report.ageSeconds),
        })}
      </Text>
    </View>
  );
}

function statusKey(status: string | null): 'ok' | 'degraded' | 'down' {
  return status === 'ok' || status === 'down' ? status : 'degraded';
}

function componentName(component: DiagnosticsComponent, t: TFunction) {
  const n = Number((component.id ?? '').split(':')[1] ?? 1);
  switch (component.kind) {
    case 'provider':
      return t('settings.connection.server.component.provider', { n });
    case 'indexer':
      return t('settings.connection.server.component.indexer', { n });
    case 'database':
    case 'metadata':
    case 'disk':
    case 'streams':
      return t(`settings.connection.server.component.${component.kind}`);
    default:
      return component.name ?? '';
  }
}

function componentDetail(
  component: DiagnosticsComponent,
  t: TFunction,
  number: (value: number) => string
) {
  const parts: string[] = [];
  const code = oneOf(ERROR_CODES, component.errorCode);
  const status = oneOf(COMPONENT_STATUSES, component.status);
  if (code) parts.push(t(`settings.connection.server.errorCode.${code}`));
  else if (status) parts.push(t(`settings.connection.server.componentStatus.${status}`));
  if (component.kind === 'streams' && component.activeStreams != null)
    parts.push(t('settings.connection.server.streams', { count: component.activeStreams }));
  if (component.connectionsInUse != null && component.connectionsMax != null)
    parts.push(
      t('settings.connection.server.connections', {
        used: component.connectionsInUse,
        max: component.connectionsMax,
      })
    );
  if (component.latencyMs != null)
    parts.push(t('settings.connection.speed.ms', { value: number(component.latencyMs) }));
  return parts.join(' · ');
}

function ComponentRow({ component }: { component: DiagnosticsComponent }) {
  const { t } = useTranslation();
  const design = useDesign();
  const number = useNumber();
  const name = componentName(component, t);
  const detail = componentDetail(component, t, number);
  const dot = design.px(10);
  // Phones stack the detail under the name so neither is cut off.
  const stacked = design.formFactor === 'phone';
  const detailText = (
    <Text
      testID={`connection-component-${component.id}-detail`}
      variant="callout"
      tone={
        component.status === 'ok' ? 'muted' : component.status === 'down' ? 'danger' : 'warning'
      }
      style={stacked ? undefined : { flexShrink: 1, textAlign: 'right' }}>
      {detail}
    </Text>
  );
  const row = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: stacked ? 'flex-start' : 'center',
        gap: design.space.md,
        paddingVertical: design.space.xs,
        paddingHorizontal: design.space.sm,
      }}>
      <View
        testID={`connection-component-${component.id}-dot`}
        style={{
          width: dot,
          height: dot,
          borderRadius: dot,
          marginTop: stacked ? design.px(7) : 0,
          backgroundColor: STATUS_COLOR[component.status ?? ''] ?? colors.foreground.subtle,
        }}
      />
      {stacked ? (
        <View style={{ flex: 1, gap: design.space.xxs }}>
          <Text variant="body">{name}</Text>
          {detailText}
        </View>
      ) : (
        <>
          <Text variant="body" style={{ flexShrink: 0, minWidth: '30%' }} numberOfLines={1}>
            {name}
          </Text>
          <View style={{ flex: 1 }} />
          {detailText}
        </>
      )}
    </View>
  );
  // TV: rows take focus so the remote can scroll through the whole list.
  if (!design.isTV) {
    return (
      <View
        testID={`connection-component-${component.id}`}
        accessible
        aria-label={`${name}: ${detail}`}>
        {row}
      </View>
    );
  }
  return (
    <Focusable
      testID={`connection-component-${component.id}`}
      accessibilityLabel={`${name}: ${detail}`}>
      <FocusLift kind="none" radius={design.radius.sm}>
        {row}
      </FocusLift>
    </Focusable>
  );
}
