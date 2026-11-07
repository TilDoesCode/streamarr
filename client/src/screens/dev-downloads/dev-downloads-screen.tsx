import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DownloadsLibrary } from '@/components/downloads';
import { gutterPadding, useDesign } from '@/theme';

/** Dev builds: the downloads library online (DL-C1 device checks before DL-C2's Downloads tab is merged). */
export function DevDownloadsScreen() {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID="dev-downloads-screen"
      contentContainerStyle={{
        paddingTop: insets.top + design.layout.edgeVertical,
        paddingBottom: insets.bottom + design.layout.edgeVertical,
        ...gutterPadding(design),
        gap: design.layout.sectionGap,
        width: '100%',
        maxWidth: design.layout.maxContentWidth,
        alignSelf: 'center',
      }}>
      <DownloadsLibrary />
    </ScrollView>
  );
}
