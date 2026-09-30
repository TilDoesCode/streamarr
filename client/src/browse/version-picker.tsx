import {
  CircleAlert,
  CircleCheck,
  Download,
  Film,
  Gauge,
  Repeat,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { toAppError } from '@/api/errors';
import { useVersions, type Version } from '@/browse/queries';
import {
  predictedMethod,
  predictionReasons,
  versionDetails,
  versionFormats,
  versionHeadline,
  type PredictedMethod,
} from '@/browse/version-format';
import { Focusable, FocusLift, useFocusState, useInitialFocus } from '@/components/focus';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, useSheetRoving } from '@/components/ui/sheet';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { colors, useDesign } from '@/theme';

const METHOD: Record<PredictedMethod, { icon: LucideIcon; variant: BadgeVariant }> = {
  direct: { icon: Zap, variant: 'success' },
  remux: { icon: Repeat, variant: 'info' },
  transcode: { icon: Gauge, variant: 'warning' },
  unknown: { icon: CircleAlert, variant: 'neutral' },
};

export type VersionPickerProps = {
  open: boolean;
  onClose: () => void;
  workId: string | null | undefined;
  title: string;
  /** The version the viewer played last (marked as current). */
  currentReleaseId?: string | null;
  onPlay: (version: Version) => void;
};

/** Ranked versions with their attributes and how this device would play them. */
export function VersionPicker({
  open,
  onClose,
  workId,
  title,
  currentReleaseId,
  onPlay,
}: VersionPickerProps) {
  const { t } = useTranslation();
  const versions = useVersions(workId, open);
  const list = versions.data?.versions ?? [];
  const error = versions.error ? toAppError(versions.error) : undefined;

  let body;
  if (versions.data === undefined && error)
    body = (
      <ErrorState
        testID="versions-error"
        code={error.code}
        actions={['retry']}
        autoFocus
        onAction={() => void versions.refetch()}
      />
    );
  else if (versions.data === undefined)
    body = [0, 1, 2].map((index) => <VersionCardSkeleton key={index} />);
  else if (!list.length)
    body = (
      <EmptyState
        testID="versions-empty"
        icon={Film}
        title={t('versions.emptyTitle')}
        message={t('versions.emptyMessage')}
      />
    );
  else
    body = list.map((version, index) => (
      <VersionCard
        key={version.releaseId ?? index}
        version={version}
        preferred={currentReleaseId ? version.releaseId === currentReleaseId : index === 0}
        current={!!currentReleaseId && version.releaseId === currentReleaseId}
        onPress={() => onPlay(version)}
      />
    ));

  return (
    <Sheet
      testID="version-picker"
      open={open}
      onClose={onClose}
      wide
      title={t('versions.title')}
      subtitle={
        versions.data
          ? versions.data.incomplete
            ? t('versions.incomplete', { title })
            : t('versions.subtitle', { title, count: list.length })
          : title
      }>
      {body}
    </Sheet>
  );
}

function VersionCard({
  version,
  preferred,
  current,
  onPress,
}: {
  version: Version;
  preferred: boolean;
  current: boolean;
  onPress: () => void;
}) {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const roving = useSheetRoving();
  const ref = useRef<View>(null);
  useInitialFocus(ref, preferred);
  const radius = design.radius.lg;
  const method = predictedMethod(version);
  const reasons = predictionReasons(version, t);
  const headline = versionHeadline(version) || version.name || '';
  const facts = [
    version.sizeBytes ? format.fileSize(version.sizeBytes) : null,
    version.estimatedBitrateKbps
      ? t('versions.bitrate', { mbps: version.estimatedBitrateKbps / 1000 })
      : null,
    version.ageDays != null ? t('versions.age', { days: version.ageDays }) : null,
  ].filter((part): part is string => !!part);
  const lines = [
    versionFormats(version, t).join(' · '),
    versionDetails(version, t, i18n.language).join(' · '),
    facts.join(' · '),
  ].filter(Boolean);
  const methodLabel = method ? t(`versions.method.${method}`) : undefined;

  return (
    <Focusable
      ref={ref}
      testID={`version-${version.rank}`}
      role="radio"
      aria-checked={current}
      accessibilityLabel={[headline, ...lines, methodLabel].filter(Boolean).join('. ')}
      {...roving}
      onPress={onPress}>
      <FocusLift kind="none" radius={radius}>
        <VersionSurface radius={radius}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.xs }}>
            {version.recommended ? (
              <Badge label={t('media.recommended')} variant="accent" icon={Sparkles} />
            ) : null}
            {current ? <Badge label={t('versions.current')} variant="outline" /> : null}
            {version.local === 'ready' ? (
              <Badge label={t('versions.local.ready')} variant="success" icon={Zap} />
            ) : version.local === 'downloading' ? (
              <Badge label={t('versions.local.downloading')} variant="info" icon={Download} />
            ) : null}
            {version.health === 'ready' ? (
              <Badge label={t('versions.health.ready')} variant="success" icon={CircleCheck} />
            ) : version.health === 'degraded' ? (
              <Badge label={t('versions.health.degraded')} variant="warning" icon={CircleAlert} />
            ) : null}
          </View>
          <Text variant="heading" numberOfLines={2}>
            {headline}
          </Text>
          {lines.map((line, index) => (
            <Text key={index} variant="callout" tone={index === 0 ? 'default' : 'muted'}>
              {line}
            </Text>
          ))}
          {method && methodLabel ? (
            <View style={{ gap: design.space.xxs, marginTop: design.space.xxs }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                <Badge
                  testID={`version-${version.rank}-method`}
                  label={methodLabel}
                  variant={METHOD[method].variant}
                  icon={METHOD[method].icon}
                />
                <Text variant="caption" tone="subtle">
                  {t('versions.predicted')}
                </Text>
              </View>
              {reasons.length ? (
                <Text variant="caption" tone="subtle" numberOfLines={3}>
                  {reasons.join(' · ')}
                </Text>
              ) : null}
            </View>
          ) : null}
          <Text variant="caption" tone="subtle" numberOfLines={1}>
            {version.name ?? ''}
          </Text>
        </VersionSurface>
      </FocusLift>
    </Focusable>
  );
}

function VersionSurface({ radius, children }: { radius: number; children: React.ReactNode }) {
  const design = useDesign();
  const { focus, hover, pressed } = useFocusState();
  const style = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      Math.max(focus.get(), hover.get() * 0.6, pressed.get()),
      [0, 1],
      [colors.surface.DEFAULT, colors.surface.overlay]
    ),
  }));
  return (
    <Animated.View
      style={[
        {
          gap: design.space.xs,
          padding: design.space.md,
          borderRadius: radius,
          borderCurve: 'continuous',
          marginBottom: design.space.xs,
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}

function VersionCardSkeleton() {
  const design = useDesign();
  return (
    <View
      testID="versions-loading"
      style={{ gap: design.space.sm, padding: design.space.md, marginBottom: design.space.xs }}>
      <Skeleton width={design.px(96)} height={design.px(18)} radius={design.radius.sm} />
      <SkeletonText width="60%" variant="heading" />
      <SkeletonText width="85%" />
      <SkeletonText width="40%" variant="caption" />
    </View>
  );
}

/** "Versions" button of a detail screen. */
export function VersionsButton({ onPress, testID }: { onPress: () => void; testID?: string }) {
  const { t } = useTranslation();
  return (
    <Button
      testID={testID}
      variant="secondary"
      icon={Film}
      label={t('common.versions')}
      onPress={onPress}
    />
  );
}
