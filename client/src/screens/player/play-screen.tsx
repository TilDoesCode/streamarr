import { useLocalSearchParams, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CENTRED_ROW, FocusGuide } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { LoaderMotionContext } from '@/components/ui/loader-motion';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

/** Player route placeholder: full-screen surface with the transport layout; M4.2 plays here. */
export function PlayScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ playbackId: string; title?: string }>();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View
      testID={`play-screen-${params.playbackId}`}
      style={{ flex: 1, backgroundColor: colors.video }}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: design.space.md,
          paddingHorizontal: design.layout.gutter,
        }}>
        <Text variant="overline" tone="accent">
          {t('player.title')}
        </Text>
        {params.title ? (
          <Text variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
            {params.title}
          </Text>
        ) : null}
        <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
          {t('player.placeholder')}
        </Text>
        <FocusGuide remember trap={CENTRED_ROW} style={{ marginTop: design.space.md }}>
          <Button
            testID="play-close"
            icon={X}
            variant="secondary"
            label={t('common.close')}
            hasTVPreferredFocus
            onPress={close}
          />
        </FocusGuide>
      </View>
      <LoaderMotionContext value={false}>
        <View
          style={{
            paddingHorizontal: design.layout.gutter,
            paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space.lg,
            gap: design.space.sm,
          }}>
          <Skeleton height={design.px(4)} radius={design.radius.full} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonText width={design.px(48)} variant="caption" />
            <SkeletonText width={design.px(48)} variant="caption" />
          </View>
        </View>
      </LoaderMotionContext>
    </View>
  );
}
