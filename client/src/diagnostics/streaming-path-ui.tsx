import type { TFunction } from 'i18next';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { END_OF_ROW, FocusGuide, FocusSection, useInitialFocus } from '@/components/focus';
import { Cloud, Gauge, Server, Smartphone, Tv, X, type LucideIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FormMessage, type FormMessageTone } from '@/components/ui/form-message';
import { Text } from '@/components/ui/text';
import { colors, useDesign, useFocusGap } from '@/theme';

import { isFreshBandwidth, useDeviceBandwidth } from './device-bandwidth';
import type { SpeedVerdict } from './speed-test';
import { pathVerdict } from './streaming-path';
import type { useSpeedTest } from './use-diagnostics';
import { useRelativeNow } from './use-relative-now';
import { useUsenetSpeed, type UsenetSpeedResult } from './usenet-speed';

const TIER_TONE: Record<SpeedVerdict, FormMessageTone> = {
  uhdRemux: 'success',
  uhd: 'success',
  fhd: 'info',
  hd: 'warning',
  tooSlow: 'danger',
};

const USENET_CODES = [
  'connect_failed',
  'auth_failed',
  'no_article',
  'timeout',
  'no_data',
  'no_free_connections',
  'no_providers',
  'error',
] as const;

function codeText(t: TFunction, code: string | null | undefined) {
  const known = USENET_CODES.find((item) => item === code) ?? 'error';
  return t(`settings.connection.path.code.${known}`);
}

function providerText(t: TFunction, provider: { index: number; role: string | null }) {
  return provider.role === 'primary'
    ? t('settings.connection.path.primary')
    : t('settings.connection.path.backup', { n: provider.index });
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function measuredAgo(t: TFunction, measuredAt: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - measuredAt) / 60_000));
  if (minutes < 1) return t('settings.connection.path.ago.now');
  if (minutes < 60) return t('settings.connection.path.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('settings.connection.path.ago.hours', { count: hours });
  return t('settings.connection.path.ago.days', { count: Math.floor(hours / 24) });
}

/** A speed at the test's ceiling is only a lower bound. */
export function atLeast(text: string, limited?: boolean) {
  return limited ? `≥ ${text}` : text;
}

function useMbps() {
  const { t, i18n } = useTranslation();
  return (value: number) =>
    value >= 1000
      ? t('settings.connection.speed.gbps', {
          value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
            value / 1000
          ),
        })
      : t('settings.connection.speed.mbps', {
          value: new Intl.NumberFormat(i18n.language, {
            maximumFractionDigits: value < 10 ? 1 : 0,
          }).format(value),
        });
}

type LegState = 'idle' | 'running' | 'bottleneck' | 'failed';

/** The streaming path's measurements: the Usenet run, the device test and "Measure everything" (Usenet first, then the device). */
export function usePathMeasurement(speed: ReturnType<typeof useSpeedTest>) {
  const { query, run } = useUsenetSpeed();
  const [all, setAll] = useState(false);
  const allowed = query.data?.allowed ?? true;
  const usenetRunning = run.isPending || !!query.data?.running;
  const deviceRunning = speed.state.status === 'running';
  const busy = usenetRunning || deviceRunning || all;
  // Our own work: a Usenet test another caller started is joined by pressing, never blocks the buttons.
  const working = run.isPending || deviceRunning || all;
  // A new run starts with a clean slate: no leg keeps showing the error of an earlier run.
  const clearErrors = () => {
    run.reset();
    speed.reset();
  };
  const measureUsenet = async () => {
    clearErrors();
    try {
      await run.mutateAsync();
    } catch {
      // shown below the path
    }
  };
  const measureDevice = async () => {
    clearErrors();
    await speed.start();
  };
  const measureAll = async () => {
    if (working) return;
    setAll(true);
    try {
      if (allowed) await measureUsenet();
      else clearErrors();
      await speed.start();
    } finally {
      setAll(false);
    }
  };
  return {
    speed,
    query,
    run,
    all,
    allowed,
    usenetRunning,
    deviceRunning,
    busy,
    working,
    measureAll,
    measureUsenet,
    measureDevice,
  };
}

export type PathMeasurement = ReturnType<typeof usePathMeasurement>;

/** Label of "Measure everything" (only the device when the viewer may not test Usenet), shared with the verdict's shortcut. */
export function measureAllLabel(t: TFunction, allowed: boolean) {
  return t(
    allowed ? 'settings.connection.path.measureAll' : 'settings.connection.path.measureDevice'
  );
}

/**
 * Settings → Connection & diagnostics: Usenet → server → this device with each leg's measured speed, the slower leg as
 * the limit in plain words, "Measure everything" (Usenet first, then this device, so they never share the line) and
 * one button per leg — the screen's only place that starts a measurement (the verdict's shortcut hands over here).
 */
export function StreamingPathCard({
  path,
  preferFocus,
  allShown = true,
}: {
  path: PathMeasurement;
  /** TV: the card's first button takes focus (no verdict to focus, or the verdict handed over). */
  preferFocus?: boolean;
  /** False while the verdict offers the same "Measure everything". */
  allShown?: boolean;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const mbps = useMbps();
  const now = useRelativeNow();
  const { account } = useActiveAccount();
  const device = useDeviceBandwidth(account.serverUrl);
  const {
    speed,
    query,
    run,
    all,
    allowed,
    usenetRunning,
    deviceRunning,
    busy,
    working,
    measureAll,
    measureUsenet,
    measureDevice,
  } = path;
  const allRef = useRef<View>(null);
  const firstRef = useRef<View>(null);
  useInitialFocus(allShown ? allRef : firstRef, !!preferFocus);
  const phone = design.formFactor === 'phone';

  const latest: UsenetSpeedResult | null | undefined = run.data ?? query.data?.latest;
  const usenetMbps = latest?.status === 'ok' ? (latest.megabitsPerSecond ?? undefined) : undefined;
  const freshDevice = isFreshBandwidth(device) ? device : undefined;
  const live =
    deviceRunning && speed.state.status === 'running' && speed.state.progress?.phase === 'download'
      ? speed.state.progress.liveMbps
      : undefined;
  const verdict = busy
    ? undefined
    : pathVerdict(usenetMbps, freshDevice?.downloadMbps, freshDevice?.downloadLimited);
  const bottleneck = verdict?.kind === 'both' ? verdict.bottleneck : undefined;

  const usenetDetail = (() => {
    if (usenetRunning) return t('settings.connection.path.usenetRunning');
    if (!latest) return t('settings.connection.path.notMeasured');
    const parts = [measuredAgo(t, Date.parse(latest.measuredAt), now)];
    if (latest.provider) parts.push(providerText(t, latest.provider));
    return parts.join(' · ');
  })();
  const deviceDetail = deviceRunning
    ? t('settings.connection.path.deviceRunning')
    : device
      ? [
          measuredAgo(t, device.measuredAt, now),
          freshDevice ? null : t('settings.connection.path.stale'),
        ]
          .filter(Boolean)
          .join(' · ')
      : t('settings.connection.path.notMeasured');

  const usenetLeg = (
    <Leg
      testID="connection-path-usenet"
      label={t('settings.connection.path.legUsenet')}
      value={
        usenetRunning
          ? t('settings.connection.speed.none')
          : latest?.status === 'failed'
            ? t('settings.connection.path.failed')
            : usenetMbps !== undefined
              ? mbps(usenetMbps)
              : t('settings.connection.speed.none')
      }
      detail={usenetDetail}
      state={
        usenetRunning
          ? 'running'
          : latest?.status === 'failed'
            ? 'failed'
            : bottleneck === 'usenet'
              ? 'bottleneck'
              : 'idle'
      }
      vertical={phone}
    />
  );
  const deviceLeg = (
    <Leg
      testID="connection-path-device"
      label={t('settings.connection.path.legDevice')}
      value={
        deviceRunning
          ? live !== undefined
            ? mbps(live)
            : t('settings.connection.speed.none')
          : device
            ? atLeast(mbps(device.downloadMbps), device.downloadLimited)
            : t('settings.connection.speed.none')
      }
      detail={deviceDetail}
      state={deviceRunning ? 'running' : bottleneck === 'device' ? 'bottleneck' : 'idle'}
      vertical={phone}
    />
  );
  const DeviceIcon = Platform.isTV ? Tv : Smartphone;

  return (
    <FocusSection testID="connection-path">
      <View style={{ gap: design.space.lg }}>
        <View style={{ gap: design.space.xs }}>
          <Text variant="overline" tone="subtle">
            {t('settings.connection.path.title')}
          </Text>
          <Text variant="callout" tone="muted">
            {t('settings.connection.path.intro')}
          </Text>
        </View>
        <View
          testID="connection-path-diagram"
          style={{
            flexDirection: phone ? 'column' : 'row',
            alignItems: phone ? 'stretch' : 'flex-start',
            gap: phone ? design.space.xs : design.space.md,
          }}>
          <Stop
            testID="connection-path-stop-usenet"
            icon={Cloud}
            label={t('settings.connection.path.stopUsenet')}
            vertical={phone}
          />
          {usenetLeg}
          <Stop
            testID="connection-path-stop-server"
            icon={Server}
            label={t('settings.connection.path.stopServer')}
            vertical={phone}
          />
          {deviceLeg}
          <Stop
            testID="connection-path-stop-device"
            icon={DeviceIcon}
            label={t('settings.connection.path.stopDevice')}
            vertical={phone}
          />
        </View>
        <PathButtons>
          {allShown ? (
            <Button
              ref={allRef}
              testID="connection-path-all"
              icon={Gauge}
              hasTVPreferredFocus={preferFocus}
              loading={all}
              label={measureAllLabel(t, allowed)}
              onPress={() => void measureAll()}
            />
          ) : null}
          {allowed ? (
            <Button
              ref={allShown ? undefined : firstRef}
              testID="connection-path-usenet-run"
              variant="secondary"
              icon={Cloud}
              hasTVPreferredFocus={!allShown && preferFocus}
              loading={run.isPending && !all}
              label={t('settings.connection.path.measureUsenet')}
              onPress={() => {
                if (!working) void measureUsenet();
              }}
            />
          ) : null}
          {deviceRunning ? (
            <Button
              testID="connection-path-cancel"
              variant="secondary"
              icon={X}
              label={t('common.cancel')}
              onPress={speed.cancel}
            />
          ) : allowed ? (
            <Button
              testID="connection-path-device-run"
              variant="secondary"
              icon={DeviceIcon}
              label={t('settings.connection.path.measureDevice')}
              onPress={() => {
                if (!working) void measureDevice();
              }}
            />
          ) : null}
        </PathButtons>
        {/* Below the buttons: what appears or goes while measuring never moves the focused button. */}
        {verdict ? <PathVerdictMessage verdict={verdict} mbps={mbps} /> : null}
        {all ? (
          <Text testID="connection-path-step" variant="callout" tone="muted">
            {t(
              usenetRunning
                ? 'settings.connection.path.stepUsenet'
                : 'settings.connection.path.stepDevice'
            )}
          </Text>
        ) : usenetRunning && !run.isPending ? (
          <Text testID="connection-path-joined" variant="callout" tone="muted">
            {t('settings.connection.path.usenetJoin')}
          </Text>
        ) : null}
        <UsenetNotes latest={latest} allowed={allowed} running={usenetRunning} />
        {run.error ? (
          <FormMessage
            testID="connection-path-error"
            tone="warning"
            title={describeError(t, toAppError(run.error)).title}
            message={describeError(t, toAppError(run.error)).message}
          />
        ) : null}
        {speed.state.status === 'error' ? (
          <FormMessage
            testID="connection-path-device-error"
            tone="warning"
            title={t('settings.connection.speed.error')}
            message={describeError(t, toAppError(speed.state.error)).message}
          />
        ) : null}
      </View>
    </FocusSection>
  );
}

function PathButtons({ children }: { children: ReactNode }) {
  const design = useDesign();
  const gap = useFocusGap(design.space.md);
  return (
    <FocusGuide remember trap={END_OF_ROW} style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {children}
    </FocusGuide>
  );
}

/** A node of the path: as wide as its label and never squeezed, so the legs between the nodes take all the slack. */
function Stop({
  icon: Icon,
  label,
  vertical,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  vertical: boolean;
  testID: string;
}) {
  const design = useDesign();
  const size = design.px(44);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: vertical ? 'row' : 'column',
        alignItems: 'center',
        gap: design.space.sm,
        flexShrink: 0,
      }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.glass.DEFAULT,
          borderWidth: 1,
          borderColor: colors.glass.border,
        }}>
        <Icon size={design.layout.iconSize.sm} color={colors.foreground.DEFAULT} strokeWidth={2} />
      </View>
      <Text variant="callout" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const LEG_COLOR: Record<LegState, string> = {
  idle: colors.foreground.subtle,
  running: colors.info.DEFAULT,
  bottleneck: colors.warning.DEFAULT,
  failed: colors.danger.DEFAULT,
};

function Leg({
  label,
  value,
  detail,
  state,
  vertical,
  testID,
}: {
  label: string;
  value: string;
  detail: string;
  state: LegState;
  vertical: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const line = (
    <View
      style={
        vertical
          ? { width: design.px(3), alignSelf: 'stretch', marginHorizontal: design.px(20.5) }
          : { height: design.px(3), alignSelf: 'stretch', marginTop: design.px(20.5) }
      }>
      <View style={{ flex: 1, borderRadius: design.px(2), backgroundColor: LEG_COLOR[state] }} />
    </View>
  );
  const texts = (
    <View
      style={{
        gap: design.space.xxs,
        alignItems: vertical ? 'flex-start' : 'center',
        paddingVertical: vertical ? design.space.sm : 0,
        flexShrink: 1,
      }}>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Text testID={`${testID}-value`} variant="heading" numberOfLines={1}>
        {value}
      </Text>
      <Text
        testID={`${testID}-detail`}
        variant="caption"
        tone={state === 'failed' ? 'danger' : 'muted'}
        style={vertical ? undefined : { textAlign: 'center' }}>
        {detail}
      </Text>
      {state === 'bottleneck' ? (
        <View
          testID={`${testID}-bottleneck`}
          style={{
            borderRadius: design.radius.sm,
            paddingHorizontal: design.space.sm,
            backgroundColor: colors.warning.muted,
          }}>
          <Text variant="caption" style={{ color: colors.warning.DEFAULT }}>
            {t('settings.connection.path.bottleneckBadge')}
          </Text>
        </View>
      ) : null}
    </View>
  );
  return (
    <View
      testID={testID}
      accessible
      aria-label={`${label}: ${value}, ${detail}`}
      style={
        vertical
          ? { flexDirection: 'row', alignItems: 'stretch' }
          : { flex: 1, minWidth: 0, gap: design.space.sm }
      }>
      {line}
      {texts}
    </View>
  );
}

function PathVerdictMessage({
  verdict,
  mbps,
}: {
  verdict: ReturnType<typeof pathVerdict>;
  mbps: (value: number) => string;
}) {
  const { t } = useTranslation();
  if (verdict.kind === 'none')
    return (
      <FormMessage
        testID="connection-path-verdict"
        tone="info"
        title={t('settings.connection.path.verdict.none.title')}
        message={t('settings.connection.path.verdict.none.message')}
      />
    );
  const speed = mbps(verdict.limitMbps);
  const consequence = t(`settings.connection.path.consequence.${verdict.tier}`);
  const kind = verdict.kind === 'both' ? verdict.bottleneck : verdict.kind;
  return (
    <FormMessage
      testID="connection-path-verdict"
      tone={TIER_TONE[verdict.tier]}
      title={t(`settings.connection.path.verdict.${kind}.title`, { speed })}
      message={t(`settings.connection.path.verdict.${kind}.message`, { speed, consequence })}
    />
  );
}

function UsenetNotes({
  latest,
  allowed,
  running,
}: {
  latest: UsenetSpeedResult | null | undefined;
  allowed: boolean;
  running: boolean;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const notes: { id: string; text: string; tone?: 'danger' | 'warning' }[] = [];
  if (!allowed) notes.push({ id: 'not-allowed', text: t('settings.connection.path.notAllowed') });
  if (latest && !running) {
    const failed = latest.attempts?.filter((attempt) => attempt.code !== 'ok') ?? [];
    if (latest.status === 'failed')
      notes.push({
        id: 'failed',
        tone: 'danger',
        text: t('settings.connection.path.failedNote', {
          reasons:
            failed.length > 0
              ? failed.map((a) => `${providerText(t, a)}: ${codeText(t, a.code)}`).join(' · ')
              : codeText(t, latest.code),
        }),
      });
    else if (latest.fallbackUsed && latest.provider)
      notes.push({
        id: 'fallback',
        tone: 'warning',
        text: t('settings.connection.path.fallback', {
          reason: failed.map((a) => codeText(t, a.code)).join(', ') || codeText(t, 'error'),
          provider: providerText(t, latest.provider),
        }),
      });
    if (latest.status === 'ok' && (latest.activeStreams ?? 0) > 0)
      notes.push({
        id: 'streams',
        text: t('settings.connection.path.activeStreams', { count: latest.activeStreams }),
      });
  }
  if (!notes.length) return null;
  return (
    <View style={{ gap: design.space.xs }}>
      {notes.map((note) => (
        <Text
          key={note.id}
          testID={`connection-path-note-${note.id}`}
          variant="callout"
          tone={note.tone ?? 'muted'}>
          {note.text}
        </Text>
      ))}
    </View>
  );
}
