import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Version } from '@/browse/queries';
import {
  useVersionSheetParts,
  VersionSheetPanel,
  versionSheetFrame,
  type VersionSheetProps,
} from '@/browse/version-sheet';
import { playHref } from '@/navigation/routes';
import { useDesign } from '@/theme';

/** `versions/[workId]`: the version sheet on every device (TV side sheet, web/tablet drawer, iOS formSheet). */
export function VersionSheetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    workId: string;
    title?: string;
    current?: string;
    start?: string;
  }>();
  const title = params.title ?? '';
  const frame = versionSheetFrame();
  const props: VersionSheetProps = {
    workId: params.workId,
    title,
    currentReleaseId: params.current,
    onClose: () => router.back(),
    onPlay: (version: Version) => {
      router.back();
      router.push(
        playHref({
          workId: params.workId,
          title,
          releaseId: version.releaseId,
          startSeconds: params.start ? Number(params.start) : undefined,
        })
      );
    },
  };
  if (frame === 'form') return <FormSheet {...props} />;
  return <VersionSheetPanel {...props} frame={frame} />;
}

/** iOS: native formSheet with transparent content, so iOS 26 draws the sheet in Liquid Glass. */
function FormSheet(props: VersionSheetProps) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { header, cards } = useVersionSheetParts({ ...props, frame: 'form' });
  return (
    <ScrollView
      testID="version-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: design.layout.gutter,
        paddingBottom: insets.bottom + design.space.xl,
        gap: design.space.md,
      }}>
      <View>{header}</View>
      {cards}
    </ScrollView>
  );
}
