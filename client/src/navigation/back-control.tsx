import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassButton } from '@/components/glass';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { useWindowControlsInset } from '@/shell/window-controls';
import { useDesign } from '@/theme';

const MIN_SIZE = 44;
// Phone detail header row the control is centred in.
export const PHONE_HEADER_HEIGHT = 60;

/** Pushed pages need a drawn back control everywhere but TV (Menu/Back) and iPhone (native header). */
function useNeedsBackControl(): boolean {
  const design = useDesign();
  const shell = useShell();
  return !design.isTV && (shell.large || Platform.OS !== 'ios');
}

function useBackControlSize(): number {
  const shell = useShell();
  return shell.large ? Math.max(MIN_SIZE, shell.s(SHELL.button)) : MIN_SIZE;
}

/** Top-leading corner of a pushed page: below the safe area and the iPadOS window controls. */
function useBackControlFrame(): { top: number; left: number } {
  const design = useDesign();
  const shell = useShell();
  const insets = useSafeAreaInsets();
  const windowControls = useWindowControlsInset();
  const size = useBackControlSize();
  if (shell.large)
    return {
      top: insets.top + windowControls + shell.s(SHELL.rail.top) + design.space.md,
      left: insets.left + shell.s(SHELL.row.left),
    };
  return {
    top: insets.top + windowControls + (PHONE_HEADER_HEIGHT - size) / 2,
    left: insets.left + design.layout.gutter,
  };
}

/** Content below the floating control starts at least here (0 where no control is drawn). */
export function useBackControlClearance(): number {
  const design = useDesign();
  const needed = useNeedsBackControl();
  const frame = useBackControlFrame();
  const size = useBackControlSize();
  return needed ? frame.top + size + design.space.lg : 0;
}

/** The one glass back button of detail-type pages (movie, series, season, versions). */
export function BackControl({
  floating = true,
  style,
}: {
  /** Absolute in the page's top-leading corner; `false` places it in the flow (page headings). */
  floating?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const needed = useNeedsBackControl();
  const frame = useBackControlFrame();
  const size = useBackControlSize();
  if (!needed) return null;
  return (
    <View
      style={[
        floating ? { position: 'absolute', top: frame.top, left: frame.left, zIndex: 2 } : null,
        { alignSelf: 'flex-start' },
        style,
      ]}>
      <GlassButton
        testID="detail-back"
        iconOnly
        size={size}
        icon={ArrowLeft}
        label={t('common.back')}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </View>
  );
}
