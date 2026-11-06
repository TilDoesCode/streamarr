import { useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Circle as SvgCircle } from 'react-native-svg';

import { tvFocus } from '@/components/focus';
import { GlassButton, Glass } from '@/components/glass';
import {
  CircleAlert,
  CircleArrowDown,
  CircleCheck,
  Download,
  Lock,
  type LucideIcon,
} from '@/components/icons';
import { SPEC_TONES } from '@/components/spec';
import { EpisodeRowAction } from '@/components/media/episode-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { playTitleOf } from '@/components/downloads';
import {
  downloadErrorText,
  downloadStateLabel,
  useDownloadActions,
  type OfflineDownload,
} from '@/downloads';
import { useReturnTarget } from '@/navigation/return-focus';
import { downloadHref, type DownloadSheetRequest } from '@/navigation/routes';
import type { PhoneAction } from '@/screens/detail/phone-detail';
import { colors, useDesign } from '@/theme';

import { DownloadControls, DownloadProgressLine } from './download-item';
import { failureActions } from './download-model';
import {
  useDownloadsBlocked,
  useDownloadsUi,
  useWorkDownloadUi,
  type WorkDownloadUi,
} from './use-download-ui';

/** Opens the download sheet for a movie, an episode (which can switch to its season) or a season. */
export function useOpenDownload() {
  const router = useRouter();
  return (request: DownloadSheetRequest) => router.push(downloadHref(request));
}

type EntryLook = { icon: LucideIcon; label: string; color?: string };

/** The entry's icon and label: "Download", "42 %" while it runs, "Downloaded" once it is on the device. */
export function downloadEntryLook(t: TFunction, state: WorkDownloadUi): EntryLook {
  const download = state.download;
  // Turned off by the admin: a lock (the sheet explains it on press).
  if (!download && !state.allowed)
    return { icon: Lock, label: t('downloads.detail.notAllowed'), color: colors.foreground.muted };
  if (!download) return { icon: Download, label: t('downloads.detail.action') };
  if (state.locked) return { icon: Lock, label: t('downloads.detail.locked') };
  if (download.state === 'done')
    return { icon: CircleCheck, label: t('downloads.detail.downloaded'), color: SPEC_TONES.ok.fg };
  if (download.state === 'failed')
    return { icon: CircleAlert, label: downloadStateLabel(t, 'failed'), color: SPEC_TONES.bad.fg };
  return {
    icon: CircleArrowDown,
    label:
      state.progress !== null
        ? t('downloads.detail.progressShort', { percent: Math.floor(state.progress * 100) })
        : downloadStateLabel(t, download.state),
  };
}

/** Large detail (TV, tablet): a round glass button in the action row; hidden where downloads do not exist. */
export function DownloadButton({
  request,
  tint,
  testID,
}: {
  request: DownloadSheetRequest | null;
  tint?: string | null;
  testID: string;
}) {
  const { t } = useTranslation();
  const open = useOpenDownload();
  const state = useWorkDownloadUi(request?.workId);
  const ref = useRef<View>(null);
  // TV: the sheet is its own route; once the detail is focused again, focus goes back to this button.
  const returnHere = useReturnTarget(() => tvFocus(ref.current));
  if (!state.available || !request) return null;
  const look = downloadEntryLook(t, state);
  return (
    <GlassButton
      ref={ref}
      testID={testID}
      iconOnly
      icon={look.icon}
      label={look.label}
      accessibilityLabel={
        state.download || !state.allowed
          ? t('downloads.detail.status', { state: look.label })
          : t('downloads.detail.action')
      }
      tint={tint}
      onPress={() => {
        returnHere(true);
        open(request);
      }}
    />
  );
}

/** A running, paused or failed download of this work: progress, speed, pause/resume, retry, cancel. */
export function DownloadStatusCard({
  workId,
  testID = 'detail-download',
  compact = false,
}: {
  workId: string | null | undefined;
  testID?: string;
  /** Phone detail: no glass card, a plain block under the resume line. */
  compact?: boolean;
}) {
  const state = useWorkDownloadUi(workId);
  if (!state.available || !state.download || state.download.state === 'done') return null;
  return (
    <StatusCard
      download={state.download}
      bytesPerSecond={state.bytesPerSecond}
      testID={testID}
      compact={compact}
    />
  );
}

function StatusCard({
  download,
  bytesPerSecond,
  testID,
  compact,
}: {
  download: OfflineDownload;
  bytesPerSecond: number;
  testID: string;
  compact: boolean;
}) {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const actions = useDownloadActions();
  const open = useOpenDownload();
  const failed = download.state === 'failed' ? download.error : null;
  const body = (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: design.space.md,
        maxWidth: design.px(560),
        ...(compact ? null : { padding: design.space.md }),
      }}>
      <CircleArrowDown size={design.layout.iconSize.md} color={colors.foreground.muted} />
      {/* The stage's card wraps its content, where flex: 1 would leave the text no width. */}
      <View
        style={[
          { gap: design.space.xxs },
          compact ? { flex: 1 } : { flexShrink: 1, minWidth: design.px(240) },
        ]}>
        <Text variant="callout" numberOfLines={1}>
          {downloadStateLabel(t, download.state)}
        </Text>
        <DownloadProgressLine download={download} bytesPerSecond={bytesPerSecond} testID={testID} />
        {failed ? (
          <Text testID={`${testID}-reason`} variant="caption" tone="muted">
            {downloadErrorText(t, failed, i18n.language).message}
          </Text>
        ) : null}
      </View>
      {failureActions(download).otherVersion ? (
        <Button
          testID={`${testID}-other-version`}
          size="sm"
          variant="secondary"
          label={t('downloads.detail.otherVersion')}
          onPress={() =>
            open({
              workId: download.workId,
              title: playTitleOf(t, download),
              seriesTitle: download.meta.seriesTitle,
            })
          }
        />
      ) : null}
      <DownloadControls download={download} actions={actions} testID={testID} />
    </View>
  );
  if (compact) return body;
  return (
    <Glass radius={design.radius.lg} intensity="subtle" style={{ alignSelf: 'flex-start' }}>
      {body}
    </Glass>
  );
}

/** Small mark on an episode card or row: ✓ downloaded, a progress ring while it runs, ! when it failed. */
export function EpisodeDownloadMark({
  workId,
  size,
  testID,
}: {
  workId: string | null | undefined;
  size: number;
  testID?: string;
}) {
  const { t } = useTranslation();
  const state = useWorkDownloadUi(workId);
  const download = state.download;
  if (!state.available || !download) return null;
  const look = downloadEntryLook(t, state);
  const done = download.state === 'done';
  const failed = download.state === 'failed';
  return (
    <View
      testID={testID ? `${testID}-${done ? 'done' : failed ? 'failed' : 'active'}` : undefined}
      accessibilityLabel={t('downloads.detail.status', { state: look.label })}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.scrim.strong,
      }}>
      {done || failed ? (
        <look.icon
          size={size * 0.8}
          color={look.color ?? colors.foreground.DEFAULT}
          strokeWidth={2.25}
        />
      ) : (
        <ProgressRing value={state.progress ?? 0} size={size * 0.8} />
      )}
    </View>
  );
}

function ProgressRing({ value, size }: { value: number; size: number }) {
  const stroke = Math.max(2, size * 0.14);
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  return (
    <Svg width={size} height={size} testID="download-progress-ring">
      <SvgCircle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={colors.foreground.subtle}
        strokeWidth={stroke}
        fill="none"
      />
      <SvgCircle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={colors.accent.DEFAULT}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${length * Math.min(1, Math.max(0, value))} ${length}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

/** "Season 1 · 3/10" plus "· 5/10 downloaded" once an episode of it is on the device. */
export function withSeasonDownloads(
  t: TFunction,
  label: string,
  downloaded: number,
  total: number
): string {
  return downloaded > 0
    ? `${label} · ${t('downloads.detail.seasonCount', { done: downloaded, total })}`
    : label;
}

/** Phone detail: the "Download" item of the action row (state-aware); null where downloads do not exist. */
export function downloadPhoneAction(
  t: TFunction,
  state: WorkDownloadUi,
  testID: string,
  onPress: () => void
): PhoneAction | null {
  if (!state.available) return null;
  const look = downloadEntryLook(t, state);
  return {
    testID,
    icon: look.icon,
    label: look.label,
    accessibilityLabel:
      state.download || !state.allowed
        ? t('downloads.detail.status', { state: look.label })
        : t('downloads.detail.action'),
    selected: state.download?.state === 'done',
    onPress,
  };
}

/** Phone episode row: the download state as a row action (opens the sheet: versions, or "already there"). */
export function EpisodeDownloadAction({
  request,
  testID,
}: {
  request: DownloadSheetRequest;
  testID: string;
}) {
  const { t } = useTranslation();
  const state = useWorkDownloadUi(request.workId);
  const open = useOpenDownload();
  if (!state.available) return null;
  const look = downloadEntryLook(t, state);
  return (
    <EpisodeRowAction
      testID={testID}
      icon={look.icon}
      accessibilityLabel={
        state.download || !state.allowed
          ? t('downloads.detail.status', { state: look.label })
          : t('downloads.detail.actionEpisode', { title: request.title })
      }
      onPress={() => open(request)}
    />
  );
}

/** "Download season" (phone season heading, season page); hidden where downloads do not exist. */
export function SeasonDownloadButton({
  request,
  testID,
}: {
  request: DownloadSheetRequest | null;
  testID: string;
}) {
  const { t } = useTranslation();
  const open = useOpenDownload();
  const available = !!useDownloadsUi();
  const blocked = useDownloadsBlocked();
  if (!available || !request) return null;
  return (
    <Button
      testID={testID}
      size="sm"
      variant="secondary"
      icon={blocked ? Lock : Download}
      label={t('downloads.detail.actionSeason')}
      accessibilityHint={blocked ? t('downloads.detail.notAllowed') : undefined}
      onPress={() => open(request)}
    />
  );
}
