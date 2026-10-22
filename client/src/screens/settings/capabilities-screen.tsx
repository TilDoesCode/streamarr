import type { DeviceProfile, EngineProfile, MediaCapsReport } from '@modules/media-caps';
import { chooseDecoders, passthroughDiagnosis } from '@modules/media-caps';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { RotateCcw } from '@/components/icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormMessage } from '@/components/ui/form-message';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { audioCodecLabel, hdrLabel, MEDIA_LABELS, videoCodecLabel } from '@/lib/media-labels';
import { BackControl } from '@/navigation/back-control';
import { useScreenTitle } from '@/navigation/screen-title';
import {
  applyCapabilityOverrides,
  AUDIO_CODECS,
  audioMode,
  detectedHdr,
  HDR_FORMATS,
  hasVideo,
  heightChoices,
  heightTier,
  overrideCount,
  PASSTHROUGH_CODECS,
  primaryEngine,
  profileMaxHeight,
  pruneOverrides,
  saveCapabilityOverrides,
  storedCapabilityOverrides,
  VIDEO_CODECS,
  VLC_LABEL,
  type AudioMode,
  type CapabilityOverrides,
  type EnginePreference,
} from '@/player/capability-overrides';
import { loadDetectedCaps, useCapsRefresh } from '@/player/device-profile';
import { useShell } from '@/shell/use-shell';
import { gutterPadding, useDesign, useFocusGap } from '@/theme';

const CHANNELS = [2, 6, 8] as const;
const STACK_AFTER = 4;
// Technical label, identical in every language (like MEDIA_LABELS.uhd).
const EIGHT_K = '8K';
const BITRATES = [4_000, 8_000, 15_000, 25_000, 40_000, 80_000];

/** Changed capabilities change every versions prediction and the next playback start. */
export function invalidateDeviceProfile(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['device', 'profile'] });
  void queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === 'account' && queryKey[2] === 'catalog' && queryKey[3] === 'versions',
  });
}

function heightLabel(height: number | undefined): string {
  if (!height) return '–';
  const tier = heightTier(height);
  return tier >= 4320 ? EIGHT_K : tier >= 2160 ? MEDIA_LABELS.uhd : `${tier}p`;
}

function nativeEngineName(report: MediaCapsReport): string {
  if (report.platform === 'web') return report.web?.browser ?? 'Browser';
  if (report.platform === 'android' || report.platform === 'androidtv') return 'ExoPlayer';
  return 'AVPlayer';
}

export function CapabilitiesScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const shell = useShell();
  const insets = useSafeAreaInsets();
  const title = t('settings.capabilities.title');
  useScreenTitle(title);
  useCapsRefresh();
  const caps = useQuery({
    queryKey: ['device', 'detected'],
    queryFn: loadDetectedCaps,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  // Phones show the title in the native header; the large shell (TV, web, tablet) on the page.
  const pageHeading = design.isTV || Platform.OS === 'web' || shell.large;
  return (
    <ScrollView
      testID="capabilities-screen"
      style={{ flex: 1 }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingTop: pageHeading ? design.layout.edgeVertical + insets.top : design.space.lg,
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        ...gutterPadding(design),
        gap: design.layout.sectionGap,
        width: '100%',
        maxWidth: shell.large ? shell.s(1280) : design.layout.maxContentWidth,
      }}>
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
          {t('settings.capabilities.intro')}
        </Text>
      </View>
      {caps.data ? (
        <Capabilities report={caps.data.report} detected={caps.data.profile} />
      ) : caps.error ? (
        <FormMessage
          testID="capabilities-error"
          title={t('settings.capabilities.error')}
          actions={
            <Button
              variant="secondary"
              label={t('common.retry')}
              hasTVPreferredFocus
              onPress={() => void caps.refetch()}
            />
          }
        />
      ) : (
        <View testID="capabilities-loading" style={{ gap: design.space.sm }}>
          <SkeletonText width="50%" />
          <SkeletonText width="70%" />
          <SkeletonText width="40%" />
        </View>
      )}
    </ScrollView>
  );
}

function Capabilities({ report, detected }: { report: MediaCapsReport; detected: DeviceProfile }) {
  const { t } = useTranslation();
  const design = useDesign();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState(storedCapabilityOverrides);
  const [confirm, setConfirm] = useState<CapabilityOverrides | null>(null);
  const count = overrideCount(overrides);
  const profile = applyCapabilityOverrides(detected, overrides);
  const commit = (next: CapabilityOverrides) => {
    saveCapabilityOverrides(next);
    setOverrides(next);
    invalidateDeviceProfile(queryClient);
  };
  const change = (patch: (current: CapabilityOverrides) => CapabilityOverrides) => {
    const next = pruneOverrides(patch(overrides), detected);
    // The first override asks once: from here on the viewer owns these values.
    if (count === 0 && overrideCount(next) > 0) setConfirm(next);
    else commit(next);
  };
  const reset = () => {
    if (count === 0) return;
    commit({});
    toast.show({ tone: 'success', message: t('settings.capabilities.restored') });
  };
  const decoders = chooseDecoders(report);
  const native = primaryEngine(profile);
  const maxHeight = profileMaxHeight(profile);
  const vlc = profile.engines.find((engine) => engine.engine === 'vlc');
  const detectedNative = primaryEngine(detected);
  const passthrough = report.platform !== 'web';
  const diagnosis = passthroughDiagnosis(report);
  const hdr = detectedHdr(profile);
  const detectedHdrFormats = detectedHdr(detected);
  const onOff = [
    { value: true, label: t('settings.capabilities.on') },
    { value: false, label: t('settings.capabilities.off') },
  ];
  const yesNo = (value: boolean) =>
    t(value ? 'settings.capabilities.on' : 'settings.capabilities.off');
  return (
    <>
      <FormMessage
        tone="warning"
        testID="capabilities-warning"
        title={t('settings.capabilities.warningTitle')}
        message={
          count
            ? t('settings.capabilities.overriddenCount', { count })
            : t('settings.capabilities.warning')
        }
        actions={
          <Button
            testID="capabilities-reset"
            variant="secondary"
            size="sm"
            icon={RotateCcw}
            label={t('settings.capabilities.restore')}
            // TV: a disabled button drops focus; with nothing to restore a press does nothing.
            disabled={count === 0 && !design.isTV}
            onPress={reset}
          />
        }
      />

      <Section title={t('settings.capabilities.display.title')} testID="capabilities-display">
        <InfoRow
          label={t('settings.capabilities.display.device')}
          value={
            // Web reports the whole user agent as its OS version: the browser name says enough.
            (report.web
              ? report.web.browser
              : [report.device.manufacturer, report.device.model, report.device.osVersion]
                  .filter(Boolean)
                  .join(' · ')) || t('settings.about.unavailable')
          }
        />
        <InfoRow
          label={t('settings.capabilities.display.resolution')}
          value={
            report.display.width && report.display.height
              ? [
                  `${report.display.width} × ${report.display.height}`,
                  report.display.refreshRate
                    ? `${Math.round(report.display.refreshRate)} Hz`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('settings.about.unavailable')
          }
        />
        <InfoRow
          testID="capabilities-display-hdr"
          label={t('settings.capabilities.display.hdr')}
          value={
            report.display.hdrTypes.length
              ? report.display.hdrTypes.map(hdrLabel).join(', ')
              : t('settings.capabilities.display.noHdr')
          }
        />
        <InfoRow
          label={t('settings.capabilities.display.audioOut')}
          value={[
            t('settings.capabilities.channels', { count: report.audioOutput.maxChannels }),
            report.audioOutput.passthrough.length
              ? t('settings.capabilities.display.bitstream', {
                  formats: report.audioOutput.passthrough.join(', '),
                })
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        {report.audioOutput.hdmiEncodings ? (
          <InfoRow
            testID="capabilities-hdmi-formats"
            label={t('settings.capabilities.display.hdmiFormats')}
            value={
              report.audioOutput.hdmiEncodings.join(', ') ||
              t('settings.capabilities.display.hdmiNone')
            }
          />
        ) : null}
        {diagnosis.reason ? (
          <InfoRow
            testID="capabilities-passthrough-refused"
            label={
              diagnosis.refused.length
                ? t('settings.capabilities.display.refused', {
                    formats: diagnosis.refused.map(audioCodecLabel).join(', '),
                  })
                : t('settings.capabilities.display.hdmiFormats')
            }
            value={t(`settings.capabilities.display.refusal.${diagnosis.reason}`)}
          />
        ) : null}
      </Section>

      <Section title={t('settings.capabilities.engines.title')} testID="capabilities-engines">
        {native ? (
          <EngineSummary
            name={`${t('settings.capabilities.engines.native')} (${nativeEngineName(report)})`}
            engine={native}
          />
        ) : null}
        {detected.vlcAvailable ? (
          <ChoiceRow
            testID="capabilities-vlc"
            label={VLC_LABEL}
            details={vlc ? <EngineSummary engine={vlc} /> : undefined}
            options={onOff}
            value={profile.vlcAvailable}
            overridden={overrides.vlc !== undefined}
            detected={yesNo(detected.vlcAvailable)}
            onChange={(on) => change((current) => ({ ...current, vlc: on }))}
          />
        ) : null}
        {profile.vlcAvailable ? (
          <ChoiceRow<EnginePreference>
            testID="capabilities-engine"
            label={t('settings.capabilities.engines.preferred')}
            hint={t('settings.capabilities.engines.preferredHint')}
            options={[
              { value: 'auto', label: t('settings.capabilities.engines.auto') },
              { value: 'native', label: t('settings.capabilities.engines.native') },
              { value: 'vlc', label: VLC_LABEL },
            ]}
            value={overrides.engine ?? 'auto'}
            overridden={overrides.engine !== undefined}
            detected={t('settings.capabilities.engines.auto')}
            onChange={(engine) => change((current) => ({ ...current, engine }))}
          />
        ) : null}
      </Section>

      <Section title={t('settings.capabilities.video.title')} testID="capabilities-video">
        <ChoiceRow
          testID="capabilities-max-height"
          label={t('settings.capabilities.video.maxResolution')}
          options={heightChoices(profileMaxHeight(detected)).map((height) => ({
            value: height,
            label: heightLabel(height),
          }))}
          value={maxHeight ? heightTier(maxHeight) : 0}
          overridden={overrides.maxHeight !== undefined}
          detected={heightLabel(profileMaxHeight(detected))}
          onChange={(maxHeight) => change((current) => ({ ...current, maxHeight }))}
        />
        {VIDEO_CODECS.map((codec) => {
          const choice = decoders.find((item) => item.codec === codec);
          const entry = native?.videoCodecs.find((item) => item.codec === codec);
          const vlcEntry = vlc?.videoCodecs.find((item) => item.codec === codec);
          const profiles = report.videoDecoders
            .filter((decoder) => decoder.codec === codec)
            .flatMap((decoder) => decoder.profiles ?? []);
          const on = hasVideo(profile, codec);
          return (
            <ChoiceRow
              key={codec}
              testID={`capabilities-video-${codec}`}
              label={videoCodecLabel(codec)}
              details={
                <>
                  <Detail>
                    {entry
                      ? [
                          t('settings.capabilities.upTo', {
                            resolution: heightLabel(entry.maxHeight),
                          }),
                          t('settings.capabilities.bitDepth', { bits: entry.maxBitDepth ?? 8 }),
                          entry.hdrFormats?.length
                            ? entry.hdrFormats.map(hdrLabel).join(', ')
                            : undefined,
                          choice && choice.uses !== 'none'
                            ? t(`settings.capabilities.decoder.${choice.uses}`)
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('settings.capabilities.notSupported')}
                  </Detail>
                  {profiles.length ? (
                    <Detail>
                      {t('settings.capabilities.profiles', {
                        profiles: [...new Set(profiles)].join(', '),
                      })}
                    </Detail>
                  ) : null}
                  {vlcEntry ? (
                    <Detail>
                      {t('settings.capabilities.engines.detail', {
                        engine: VLC_LABEL,
                        detail: [
                          t('settings.capabilities.upTo', {
                            resolution: heightLabel(vlcEntry.maxHeight),
                          }),
                          t('settings.capabilities.bitDepth', { bits: vlcEntry.maxBitDepth ?? 8 }),
                        ].join(' · '),
                      })}
                    </Detail>
                  ) : null}
                </>
              }
              options={onOff}
              value={on}
              overridden={overrides.video?.[codec] !== undefined}
              detected={yesNo(hasVideo(detected, codec))}
              // At least one codec stays: a profile without video cannot play anything.
              disabled={(value) => !value && on && (native?.videoCodecs.length ?? 0) <= 1}
              onChange={(value) =>
                change((current) => ({ ...current, video: { ...current.video, [codec]: value } }))
              }
            />
          );
        })}
      </Section>

      <Section title={t('settings.capabilities.hdr.title')} testID="capabilities-hdr">
        <Text variant="caption" tone="muted">
          {t('settings.capabilities.hdr.hint')}
        </Text>
        {HDR_FORMATS.map((format) => (
          <ChoiceRow
            key={format}
            testID={`capabilities-hdr-${format}`}
            label={hdrLabel(format)}
            options={onOff}
            value={hdr.has(format)}
            overridden={overrides.hdr?.[format] !== undefined}
            detected={yesNo(detectedHdrFormats.has(format))}
            onChange={(value) =>
              change((current) => ({ ...current, hdr: { ...current.hdr, [format]: value } }))
            }
          />
        ))}
      </Section>

      <Section title={t('settings.capabilities.audio.title')} testID="capabilities-audio">
        <ChoiceRow
          testID="capabilities-channels"
          label={t('settings.capabilities.audio.maxChannels')}
          options={CHANNELS.map((value) => ({
            value,
            label: t(`settings.capabilities.audio.layout${value}`),
          }))}
          value={native?.maxAudioChannels ?? 2}
          overridden={overrides.maxAudioChannels !== undefined}
          detected={t('settings.capabilities.channels', {
            count: detectedNative?.maxAudioChannels ?? 2,
          })}
          onChange={(maxAudioChannels) => change((current) => ({ ...current, maxAudioChannels }))}
        />
        {[
          ...AUDIO_CODECS,
          ...(detectedNative?.audioCodecs ?? [])
            .map((item) => item.codec)
            .filter((codec) => !AUDIO_CODECS.includes(codec)),
        ].map((codec) => {
          const entry = native?.audioCodecs.find((item) => item.codec === codec);
          const modes: AudioMode[] =
            PASSTHROUGH_CODECS.has(codec) && passthrough
              ? ['off', 'decode', 'passthrough']
              : ['off', 'decode'];
          return (
            <ChoiceRow<AudioMode>
              key={codec}
              testID={`capabilities-audio-${codec}`}
              label={audioCodecLabel(codec)}
              details={
                <>
                  <Detail>
                    {!entry
                      ? t('settings.capabilities.notSupported')
                      : entry.passthrough
                        ? t('settings.capabilities.audio.passthroughDetail')
                        : t('settings.capabilities.audio.decodeDetail', {
                            count: entry.maxChannels ?? native?.maxAudioChannels ?? 2,
                          })}
                  </Detail>
                  {vlc?.audioCodecs.some((item) => item.codec === codec) ? (
                    <Detail>
                      {t('settings.capabilities.engines.detail', {
                        engine: VLC_LABEL,
                        detail: t('settings.capabilities.audio.decode'),
                      })}
                    </Detail>
                  ) : null}
                </>
              }
              options={modes.map((mode) => ({
                value: mode,
                label: t(`settings.capabilities.audio.${mode}`),
              }))}
              value={audioMode(profile, codec)}
              overridden={overrides.audio?.[codec] !== undefined}
              detected={t(`settings.capabilities.audio.${audioMode(detected, codec)}`)}
              onChange={(mode) =>
                change((current) => ({ ...current, audio: { ...current.audio, [codec]: mode } }))
              }
            />
          );
        })}
      </Section>

      <Section title={t('settings.capabilities.network.title')} testID="capabilities-network">
        <ChoiceRow<number>
          testID="capabilities-bitrate"
          label={t('settings.capabilities.network.maxBitrate')}
          options={[
            { value: 0, label: t('settings.capabilities.network.unlimited') },
            ...BITRATES.map((kbps) => ({
              value: kbps,
              label: t('settings.capabilities.network.mbps', { value: kbps / 1000 }),
            })),
          ]}
          value={profile.maxBitrateKbps ?? 0}
          overridden={overrides.maxBitrateKbps !== undefined}
          detected={
            detected.maxBitrateKbps
              ? t('settings.capabilities.network.mbps', { value: detected.maxBitrateKbps / 1000 })
              : t('settings.capabilities.network.unlimited')
          }
          onChange={(kbps) =>
            change((current) => ({ ...current, maxBitrateKbps: kbps || undefined }))
          }
        />
      </Section>

      <Dialog
        testID="capabilities-confirm"
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('settings.capabilities.confirmTitle')}
        message={t('settings.capabilities.confirmMessage')}
        actions={[
          {
            label: t('common.cancel'),
            variant: 'secondary',
            preferred: true,
            onPress: () => setConfirm(null),
          },
          {
            label: t('settings.capabilities.confirm'),
            variant: 'destructive',
            onPress: () => {
              if (confirm) commit(confirm);
              setConfirm(null);
            },
          },
        ]}
      />
    </>
  );
}

function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID: string;
}) {
  const design = useDesign();
  return (
    <FocusSection testID={testID}>
      <View style={{ gap: design.space.lg }}>
        <Text variant="overline" tone="subtle">
          {title}
        </Text>
        {children}
      </View>
    </FocusSection>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <Text variant="caption" tone="muted">
      {children}
    </Text>
  );
}

function InfoRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const design = useDesign();
  const stacked = design.formFactor === 'phone';
  return (
    <View
      style={{
        flexDirection: stacked ? 'column' : 'row',
        gap: stacked ? design.space.xxs : design.space.lg,
        alignItems: stacked ? 'flex-start' : 'baseline',
      }}>
      <Text variant="callout" tone="muted" style={stacked ? undefined : { width: design.px(200) }}>
        {label}
      </Text>
      <Text testID={testID} variant="body" selectable style={stacked ? undefined : { flex: 1 }}>
        {value}
      </Text>
    </View>
  );
}

function EngineSummary({ name, engine }: { name?: string; engine: EngineProfile }) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <View style={{ gap: design.space.xxs }}>
      {name ? <Text variant="body">{name}</Text> : null}
      <Detail>
        {t('settings.capabilities.engines.containers', { list: engine.containers.join(', ') })}
      </Detail>
      <Detail>
        {t('settings.capabilities.engines.subtitles', {
          list: engine.subtitleFormats.join(', ') || '–',
        })}
      </Detail>
      <Detail>
        {[
          t('settings.capabilities.channels', { count: engine.maxAudioChannels }),
          engine.hls ? 'HLS' : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Detail>
    </View>
  );
}

type Option<T> = { value: T; label: string };

/** One adjustable capability: what it is, what was detected, and the choices as chips. */
function ChoiceRow<T extends string | number | boolean>({
  label,
  hint,
  details,
  options,
  value,
  overridden,
  detected,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  hint?: string;
  details?: ReactNode;
  options: Option<T>[];
  value: T;
  overridden: boolean;
  detected: string;
  disabled?: (value: T) => boolean;
  onChange: (value: T) => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  // Many choices take the whole row: the label goes above them instead of being squeezed to nothing.
  const stacked = design.formFactor === 'phone' || options.length > STACK_AFTER;
  return (
    <View
      testID={testID}
      style={{
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        gap: design.space.md,
      }}>
      <View
        style={{
          flex: stacked ? undefined : 1,
          minWidth: stacked ? undefined : '35%',
          gap: design.space.xxs,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
          <Text variant="body">{label}</Text>
          {overridden ? (
            <Badge
              testID={`${testID}-overridden`}
              variant="warning"
              label={t('settings.capabilities.overridden')}
            />
          ) : null}
        </View>
        {hint ? <Detail>{hint}</Detail> : null}
        {details}
        {overridden ? (
          <Text variant="caption" tone="warning">
            {t('settings.capabilities.detected', { value: detected })}
          </Text>
        ) : null}
      </View>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        style={{ flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, gap: chipGap }}>
        {options.map((option) => {
          const selected = option.value === value;
          const off = !selected && !!disabled?.(option.value);
          return (
            <GlassChip
              key={String(option.value)}
              testID={`${testID}-${String(option.value)}`}
              role="radio"
              aria-checked={selected}
              aria-disabled={off}
              label={option.label}
              accessibilityLabel={`${label}: ${option.label}`}
              selected={selected}
              style={off ? { opacity: 0.4 } : undefined}
              onPress={() => {
                if (!selected && !off) onChange(option.value);
              }}
            />
          );
        })}
      </FocusGuide>
    </View>
  );
}
