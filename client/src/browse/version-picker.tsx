import { Film } from 'lucide-react-native';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { Platform, View } from 'react-native';

import { toAppError } from '@/api/errors';
import { useVersions, type Version } from '@/browse/queries';
import { VersionPanelCard } from '@/browse/version-panel';
import { sheetSpecs } from '@/browse/version-format';
import { VersionSpecs } from '@/browse/version-sheet';
import { useInitialFocus } from '@/components/focus';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Sheet, useSheetRoving } from '@/components/ui/sheet';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { versionsHref, type VersionsRequest } from '@/navigation/routes';
import { useDesign } from '@/theme';

export type VersionPickerProps = {
  open: boolean;
  onClose: () => void;
  workId: string | null | undefined;
  title: string;
  /** The version the viewer played last (marked as current). */
  currentReleaseId?: string | null;
  onPlay: (version: Version) => void;
  /** Large shell: floating glass panel with the detail panel's cards. */
  glass?: boolean;
};

/** Ranked versions with their attributes and how this device would play them. */
export function VersionPicker({
  open,
  onClose,
  workId,
  title,
  currentReleaseId,
  onPlay,
  glass = false,
}: VersionPickerProps) {
  const { t } = useTranslation();
  const design = useDesign();
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
  else {
    const specs = sheetSpecs(list);
    const defaultIndex = Math.max(
      0,
      list.findIndex((item) =>
        currentReleaseId ? item.releaseId === currentReleaseId : item.recommended
      )
    );
    body = [
      specs ? (
        <View key="specs" style={{ marginBottom: design.space.sm }}>
          <VersionSpecs specs={specs} size={(value) => design.px(value * 0.75)} />
        </View>
      ) : null,
      ...list.map((version, index) => (
        <PanelOption
          key={version.releaseId ?? index}
          version={version}
          preferred={index === defaultIndex}
          current={!!currentReleaseId && version.releaseId === currentReleaseId}
          onPress={() => onPlay(version)}
        />
      )),
    ];
  }

  return (
    <Sheet
      testID="version-picker"
      open={open}
      onClose={onClose}
      wide
      glass={glass ? { width: 760 } : false}
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

function PanelOption({
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
  const roving = useSheetRoving();
  const ref = useRef<View>(null);
  useInitialFocus(ref, preferred);
  return (
    <VersionPanelCard ref={ref} version={version} current={current} onPress={onPress} {...roving} />
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

/** Opens the version picker: iPhone pushes the native formSheet route, everything else runs `inApp` (the sheet). */
export function useOpenVersions() {
  const router = useRouter();
  const design = useDesign();
  return (
    { workId, ...request }: Omit<VersionsRequest, 'workId'> & { workId?: string | null },
    inApp: () => void
  ) =>
    workId && Platform.OS === 'ios' && design.formFactor === 'phone'
      ? router.push(versionsHref({ workId, ...request }))
      : inApp();
}
