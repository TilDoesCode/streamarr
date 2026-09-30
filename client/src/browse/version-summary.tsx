import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { toAppError } from '@/api/errors';
import { useVersions } from '@/browse/queries';
import { predictedMethod, versionFormats, versionHeadline } from '@/browse/version-format';
import { Focusable, FocusLift, useFocusState } from '@/components/focus';
import { Glass } from '@/components/glass';
import { methodTone, SPEC_TONES } from '@/components/spec';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { describeError } from '@/api/error-text';
import { colors, fonts, useDesign } from '@/theme';

/** Phone: the glass "Version" card (the version that would play, its method, the count); opens the sheet. */
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
  // Play without a release id starts the server's pick: the recommended version.
  const version = list.find((item) => item.recommended) ?? list[0];
  const lastPlayed = currentReleaseId
    ? list.find((item) => item.releaseId === currentReleaseId)
    : undefined;

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
    const tone = SPEC_TONES[methodTone(method)];
    body = (
      <Focusable
        testID="versions-summary"
        role="button"
        accessibilityLabel={t('versions.openAll', { count: list.length })}
        onPress={onOpen}>
        <FocusLift kind="none" radius={RADIUS}>
          <SummarySurface>
            <View style={{ flex: 1, gap: design.space.xs }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                <Text variant="overline" tone="muted">
                  {t('versions.card')}
                </Text>
                {lastPlayed === version ? (
                  <Badge testID="versions-summary-last" label={t('versions.current')} />
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                style={{ fontFamily: fonts.displayBold, fontSize: 19, lineHeight: 24 }}>
                {versionHeadline(version) || version.name}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                {method ? (
                  <View
                    testID="versions-summary-method"
                    style={{
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      backgroundColor: tone.bg,
                    }}>
                    <Text
                      variant="caption"
                      style={{ fontFamily: fonts.bodySemiBold, color: tone.fg }}>
                      {t(`versions.method.${method}`)}
                    </Text>
                  </View>
                ) : null}
                <Text variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
                  {versionFormats(version, t).join(' · ')}
                </Text>
              </View>
              {lastPlayed && lastPlayed !== version ? (
                <Text
                  testID="versions-summary-last"
                  variant="caption"
                  tone="muted"
                  numberOfLines={1}>
                  {t('versions.lastPlayedOther', {
                    version: versionHeadline(lastPlayed) || lastPlayed.name,
                  })}
                </Text>
              ) : null}
            </View>
            <View style={{ alignItems: 'center', flexDirection: 'row', gap: 2 }}>
              <Text variant="callout" tone="muted">
                {list.length}
              </Text>
              <ChevronRight size={design.layout.iconSize.md} color={colors.foreground.muted} />
            </View>
          </SummarySurface>
        </FocusLift>
      </Focusable>
    );
  }

  return <View testID="versions-section">{body}</View>;
}

const RADIUS = 20;

/** Glass card (Aurora C-phone); lighter while pressed or focused. */
function SummarySurface({ children }: { children: React.ReactNode }) {
  const design = useDesign();
  const { focus, hover, pressed } = useFocusState();
  const style = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      Math.max(focus.get(), hover.get() * 0.6, pressed.get()),
      [0, 1],
      [colors.scrim.clear, colors.glass.subtle]
    ),
  }));
  return (
    <Glass radius={RADIUS} intensity="regular">
      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: design.space.md,
            paddingVertical: design.space.md,
            paddingHorizontal: design.space.lg,
            borderRadius: RADIUS,
            borderCurve: 'continuous',
          },
          style,
        ]}>
        {children}
      </Animated.View>
    </Glass>
  );
}
