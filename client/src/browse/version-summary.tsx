import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { toAppError } from '@/api/errors';
import { useVersions } from '@/browse/queries';
import { predictedMethod, versionFormats, versionHeadline } from '@/browse/version-format';
import {
  END_OF_ROW,
  Focusable,
  FocusGuide,
  FocusLift,
  FocusSection,
  useFocusState,
} from '@/components/focus';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { describeError } from '@/api/error-text';
import { colors, useDesign } from '@/theme';

/** Versions section of a detail screen: the version that would play, the count, and the way into the picker. */
export function VersionSummary({
  workId,
  currentReleaseId,
  onOpen,
}: {
  workId: string | null | undefined;
  currentReleaseId?: string | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const versions = useVersions(workId);
  const list = versions.data?.versions ?? [];
  const version =
    list.find((item) => currentReleaseId && item.releaseId === currentReleaseId) ??
    list.find((item) => item.recommended) ??
    list[0];

  let body;
  if (versions.data === undefined && versions.error) {
    const error = toAppError(versions.error);
    body = (
      <FormMessage
        testID="versions-summary-error"
        tone="warning"
        title={describeError(t, error).title}
        actions={
          <Button
            size="sm"
            variant="secondary"
            label={t('common.retry')}
            onPress={() => void versions.refetch()}
          />
        }
      />
    );
  } else if (versions.data === undefined) {
    body = (
      <View
        testID="versions-summary-loading"
        style={{ gap: design.space.sm, paddingVertical: design.space.sm }}>
        <SkeletonText width="40%" variant="heading" />
        <SkeletonText width="60%" />
        <Skeleton width={design.px(120)} height={design.px(20)} radius={design.radius.sm} />
      </View>
    );
  } else if (!version) {
    body = (
      <Text testID="versions-summary-empty" variant="body" tone="muted">
        {t('versions.emptyMessage')}
      </Text>
    );
  } else {
    const method = predictedMethod(version);
    body = (
      <FocusGuide remember trap={END_OF_ROW}>
        <Focusable
          testID="versions-summary"
          role="button"
          accessibilityLabel={t('versions.openAll', { count: list.length })}
          onPress={onOpen}
          style={{ alignSelf: 'flex-start', maxWidth: design.px(640), width: '100%' }}>
          <FocusLift kind="none" radius={design.radius.lg}>
            <SummarySurface>
              <View style={{ flex: 1, gap: design.space.xs }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.xs }}>
                  <Badge
                    label={
                      version.releaseId === currentReleaseId
                        ? t('versions.current')
                        : t('media.recommended')
                    }
                    variant="accent"
                  />
                  {method ? (
                    <Badge
                      testID="versions-summary-method"
                      label={t(`versions.method.${method}`)}
                    />
                  ) : null}
                </View>
                <Text variant="heading" numberOfLines={1}>
                  {versionHeadline(version) || version.name}
                </Text>
                <Text variant="callout" tone="muted" numberOfLines={1}>
                  {versionFormats(version, t).join(' · ')}
                </Text>
              </View>
              <View style={{ alignItems: 'center', flexDirection: 'row', gap: design.space.xs }}>
                <Text variant="callout" tone="muted">
                  {t('media.versions', { count: list.length })}
                </Text>
                <ChevronRight size={design.layout.iconSize.md} color={colors.foreground.muted} />
              </View>
            </SummarySurface>
          </FocusLift>
        </Focusable>
      </FocusGuide>
    );
  }

  return (
    <FocusSection testID="versions-section">
      <View style={{ gap: design.space.md, paddingHorizontal: design.layout.gutter }}>
        <Text variant="heading">{t('common.versions')}</Text>
        {body}
      </View>
    </FocusSection>
  );
}

function SummarySurface({ children }: { children: React.ReactNode }) {
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
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.lg,
          padding: design.space.lg,
          borderRadius: design.radius.lg,
          borderCurve: 'continuous',
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}
