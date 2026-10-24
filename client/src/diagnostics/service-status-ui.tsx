import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  RefreshCw,
  Gauge,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from '@/components/icons';
import { Focusable, FocusLift } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

import {
  CATEGORY_IDS,
  formatClock,
  hasProblem,
  playbackOutage,
  playbackOutageMessage,
  problemMessage,
  problemTitle,
  statusView,
  useServiceStatus,
  type ServiceCategory,
  type StatusView,
} from './service-status';

type Tone = { icon: LucideIcon; color: string; background: string };

const TONE = {
  down: { icon: CircleAlert, color: colors.danger.DEFAULT, background: colors.danger.muted },
  degraded: {
    icon: TriangleAlert,
    color: colors.warning.DEFAULT,
    background: colors.warning.muted,
  },
  unreachable: { icon: WifiOff, color: colors.danger.DEFAULT, background: colors.danger.muted },
  ok: { icon: CircleCheck, color: colors.success.DEFAULT, background: colors.success.muted },
} satisfies Record<string, Tone>;

/** The polled status as a view model; every screen shares one query. */
export function useServiceStatusView(): StatusView {
  const query = useServiceStatus();
  return statusView(query);
}

/** Opens the connection & diagnostics screen. */
export function useOpenServerStatus() {
  const router = useRouter();
  return () => router.push('/connection');
}

function toneOf(view: StatusView): Tone | null {
  if (view.kind === 'problem') return TONE[view.state];
  if (view.kind === 'unreachable') return TONE.unreachable;
  if (view.kind === 'ok') return TONE.ok;
  return null;
}

/** Headline and message of a problem or an unreachable server, in the app's language. */
function useProblemText(view: StatusView) {
  const { t, i18n } = useTranslation();
  if (view.kind === 'unreachable')
    return {
      title: t('serviceStatus.unreachable.title'),
      since: null,
      message: t('serviceStatus.unreachable.message'),
    };
  if (view.kind !== 'problem') return null;
  return {
    title: problemTitle(t, view),
    since: view.status.since
      ? t('serviceStatus.since', { time: formatClock(view.status.since, i18n.language) })
      : null,
    message: problemMessage(t, view),
  };
}

/**
 * Strip on Home, Search and My List while a service has a problem (or the server cannot be reached); opens the
 * diagnostics screen. Silent while everything is fine or the status is unknown.
 */
export function ServiceStatusBanner({
  hideUnreachable = false,
  style,
}: {
  /** The screen already shows its own "can't reach the server" state. */
  hideUnreachable?: boolean;
  style?: ViewStyle;
}) {
  const view = useServiceStatusView();
  if (!bannerShown(view, hideUnreachable)) return null;
  return <Banner view={view} style={style} />;
}

function bannerShown(view: StatusView, hideUnreachable: boolean): boolean {
  return view.kind === 'problem' || (view.kind === 'unreachable' && !hideUnreachable);
}

/** Whether the banner renders: screens skip its wrapper (and the gap it would add) otherwise. */
export function useServiceBannerShown(hideUnreachable = false): boolean {
  return bannerShown(useServiceStatusView(), hideUnreachable);
}

function Banner({ view, style }: { view: StatusView; style?: ViewStyle }) {
  const { t } = useTranslation();
  const design = useDesign();
  const open = useOpenServerStatus();
  const text = useProblemText(view);
  const tone = toneOf(view);
  if (!text || !tone) return null;
  const Icon = tone.icon;
  const headline = text.since ? `${text.title} · ${text.since}` : text.title;
  return (
    <View style={style}>
      <Focusable
        testID="service-status-banner"
        role="button"
        accessibilityLabel={t('serviceStatus.bannerLabel', {
          title: headline,
          message: text.message,
        })}
        onPress={open}>
        <FocusLift kind="none" radius={design.radius.md}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: design.space.md,
              paddingVertical: design.space.md,
              paddingHorizontal: design.space.lg,
              borderRadius: design.radius.md,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: tone.color,
              backgroundColor: tone.background,
            }}>
            <Icon size={design.layout.iconSize.md} color={tone.color} strokeWidth={2} />
            <View style={{ flex: 1, gap: design.space.xxs }}>
              <Text testID="service-status-banner-title" variant="callout">
                {headline}
              </Text>
              <Text testID="service-status-banner-message" variant="caption" tone="muted">
                {text.message}
              </Text>
            </View>
            {design.formFactor === 'phone' ? null : (
              <Text variant="label" tone="muted">
                {t('serviceStatus.details')}
              </Text>
            )}
            <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
          </View>
        </FocusLift>
      </Focusable>
    </View>
  );
}

/** One line under a failure (player card): "Usenet provider outage · It's the server, not your device." */
export function ServiceStatusLine({ testID }: { testID?: string }) {
  const { t } = useTranslation();
  const view = useServiceStatusView();
  if (view.kind !== 'problem') return null;
  return (
    <Text
      testID={testID}
      variant="callout"
      tone={view.state === 'down' ? 'danger' : 'warning'}
      style={{ textAlign: 'center' }}>
      {`${problemTitle(t, view)} · ${t('serviceStatus.notYou')}`}
    </Text>
  );
}

/** The failure card's lead while an outage explains the failure (Usenet or the server itself); null otherwise. */
export function usePlaybackOutage(): { title: string; message: string } | null {
  const { t } = useTranslation();
  const outage = playbackOutage(useServiceStatusView());
  if (!outage) return null;
  return {
    title: t('serviceStatus.playbackOutage.title'),
    message: playbackOutageMessage(t, outage),
  };
}

/** A small coloured dot (status entry, Settings tab). */
export function StatusDot({
  color,
  size,
  style,
  testID,
  label,
}: {
  color: string;
  size: number;
  style?: ViewStyle;
  testID?: string;
  label?: string;
}) {
  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={[
        {
          pointerEvents: 'none',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

/** The Settings tab's dot (rail, web top bar) while a service has a problem. */
export function SettingsTabDot({ size, style }: { size: number; style?: ViewStyle }) {
  const { t } = useTranslation();
  const view = useServiceStatusView();
  if (view.kind !== 'problem') return null;
  return (
    <StatusDot
      testID="settings-status-dot"
      label={t('serviceStatus.tabDot')}
      color={TONE[view.state].color}
      size={size}
      style={{
        position: 'absolute',
        borderWidth: Math.max(1, size * 0.18),
        borderColor: colors.background,
        ...style,
      }}
    />
  );
}

/** Whether the native Settings tab shows its dot. */
export function useSettingsTabDot(): boolean {
  return hasProblem(useServiceStatusView());
}

/** Settings, first block: coloured dot + verdict; opens the diagnostics screen. */
export function ServerStatusEntry() {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const open = useOpenServerStatus();
  const query = useServiceStatus();
  const view = statusView(query);
  const tone = toneOf(view);
  const title =
    view.kind === 'ok'
      ? t('serviceStatus.ok.title')
      : view.kind === 'problem'
        ? problemTitle(t, view)
        : view.kind === 'unreachable'
          ? t('serviceStatus.unreachable.title')
          : query.isPending
            ? t('serviceStatus.checking')
            : t('serviceStatus.unavailable');
  const checked =
    view.kind === 'ok' || view.kind === 'problem'
      ? t('serviceStatus.checkedAt', { time: formatClock(view.status.checkedAt, i18n.language) })
      : null;
  const subtitle = [t('serviceStatus.openDiagnostics'), checked].filter(Boolean).join(' · ');
  const dot = design.px(12);
  return (
    <Focusable
      testID="settings-status"
      role="button"
      accessibilityLabel={`${t('serviceStatus.sectionTitle')}: ${title}. ${subtitle}`}
      onPress={open}>
      <FocusLift kind="none" radius={design.radius.md}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: design.space.md,
            padding: design.space.md,
            borderRadius: design.radius.md,
            borderCurve: 'continuous',
            backgroundColor: colors.surface.raised,
          }}>
          <StatusDot
            testID="settings-status-entry-dot"
            color={tone?.color ?? colors.foreground.subtle}
            size={dot}
          />
          <View style={{ flex: 1, gap: design.space.xxs }}>
            <Text testID="settings-status-title" variant="body">
              {title}
            </Text>
            <Text variant="caption" tone="muted">
              {subtitle}
            </Text>
          </View>
          <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
        </View>
      </FocusLift>
    </Focusable>
  );
}

/**
 * Top of the diagnostics screen: a plain-language verdict for viewers. Everything fine → probably your connection,
 * run the speed test; a problem → since when, what does and does not work.
 */
export function ServiceVerdict({
  onSpeedTest,
  onCheckAgain,
  checking,
  preferFocus,
  speedTestOffered = true,
}: {
  /** All fine: the page's one "Start speed test" lives here until a test ran (then the speed section takes over). */
  speedTestOffered?: boolean;
  onSpeedTest: () => void;
  onCheckAgain: () => void;
  checking: boolean;
  preferFocus: boolean;
}) {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const query = useServiceStatus();
  const view = statusView(query);
  const text = useProblemText(view);
  const tone = toneOf(view);
  if (view.kind === 'unknown') {
    if (!query.isPending) return null;
    return (
      <View testID="service-verdict-loading" style={{ gap: design.space.sm }}>
        <SkeletonText width="50%" />
        <SkeletonText width="80%" />
      </View>
    );
  }
  const Icon = tone!.icon;
  const title =
    view.kind === 'ok'
      ? t('serviceStatus.ok.title')
      : view.kind === 'problem' && view.status.since
        ? t('serviceStatus.problemSince', {
            title: problemTitle(t, view),
            time: formatClock(view.status.since, i18n.language),
          })
        : (text?.title ?? '');
  const message = view.kind === 'ok' ? t('serviceStatus.ok.message') : (text?.message ?? '');
  return (
    <View
      testID="service-verdict"
      role={view.kind === 'ok' ? 'status' : 'alert'}
      aria-live="polite"
      style={{
        gap: design.space.md,
        padding: design.space.lg,
        borderRadius: design.radius.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: tone!.color,
        backgroundColor: tone!.background,
      }}>
      <View style={{ flexDirection: 'row', gap: design.space.md, alignItems: 'flex-start' }}>
        <Icon size={design.layout.iconSize.lg} color={tone!.color} strokeWidth={2} />
        <View style={{ flex: 1, gap: design.space.xs }}>
          <Text testID="service-verdict-title" variant="heading">
            {title}
          </Text>
          <Text testID="service-verdict-message" variant="body" tone="muted">
            {message}
          </Text>
        </View>
      </View>
      {view.kind === 'problem' ? (
        <View style={{ gap: design.space.md }}>
          <CategoryList
            testID="service-verdict-broken"
            title={t('serviceStatus.broken')}
            categories={view.broken}
          />
          {view.working.length ? (
            <CategoryList
              testID="service-verdict-working"
              title={t('serviceStatus.working')}
              categories={view.working}
            />
          ) : null}
        </View>
      ) : null}
      {view.kind === 'ok' && !speedTestOffered ? null : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.md }}>
          {view.kind === 'ok' ? (
            <Button
              testID="service-verdict-speed"
              icon={Gauge}
              hasTVPreferredFocus={preferFocus}
              label={t('serviceStatus.runSpeedTest')}
              onPress={onSpeedTest}
            />
          ) : (
            <Button
              testID="service-verdict-check"
              variant="secondary"
              icon={RefreshCw}
              loading={checking}
              hasTVPreferredFocus={preferFocus}
              label={t('serviceStatus.checkAgain')}
              onPress={onCheckAgain}
            />
          )}
        </View>
      )}
      {view.kind === 'ok' || view.kind === 'problem' ? (
        <Text testID="service-verdict-checked" variant="caption" tone="muted">
          {t('serviceStatus.checkedAt', {
            time: formatClock(view.status.checkedAt, i18n.language),
          })}
        </Text>
      ) : null}
    </View>
  );
}

function CategoryList({
  title,
  categories,
  testID,
}: {
  title: string;
  categories: ServiceCategory[];
  testID: string;
}): ReactNode {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <View testID={testID} style={{ gap: design.space.xs }}>
      <Text variant="overline" tone="subtle">
        {title}
      </Text>
      {categories.map((category) => {
        const state =
          category.state === 'down' || category.state === 'degraded' ? category.state : null;
        const id = CATEGORY_IDS.find((known) => known === category.id) ?? 'server';
        return (
          <View
            key={category.id}
            testID={`${testID}-${category.id}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
            <StatusDot color={state ? TONE[state].color : TONE.ok.color} size={design.px(10)} />
            <Text variant="body" style={{ flexShrink: 1 }}>
              {t(`serviceStatus.category.${id}.name`)}
            </Text>
            {state ? (
              <Text variant="callout" tone={state === 'down' ? 'danger' : 'warning'}>
                {t(`serviceStatus.state.${state}`)}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
