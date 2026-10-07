import { useIsFocused, useRouter } from 'expo-router';
import { ArrowLeft } from '@/components/icons';
import { useEffect, useEffectEvent } from 'react';
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

export type StageBackLayout = { paddingTop: number; indent: number };

/** Fixed-height stage: below the control when its top clears it, else beside it (the first row moves right). */
export function stageBackLayout({
  stageTop,
  minTop,
  frameTop,
  clearance,
  indent,
}: {
  /** Where the stage's top lands when it fills the window as authored. */
  stageTop: number;
  minTop: number;
  frameTop: number;
  clearance: number;
  indent: number;
}): StageBackLayout {
  if (clearance === 0 || stageTop >= clearance)
    return { paddingTop: Math.max(minTop, clearance), indent: 0 };
  return { paddingTop: Math.max(minTop, frameTop), indent };
}

/** The series Bühne fills the window like on TV: its logo row sits beside the back control (Q1-17). */
export function useStageBackLayout(authoredHeight: number, minTop: number): StageBackLayout {
  const design = useDesign();
  const needed = useNeedsBackControl();
  const frame = useBackControlFrame();
  const size = useBackControlSize();
  const clearance = useBackControlClearance();
  return stageBackLayout({
    stageTop: design.window.height - authoredHeight,
    minTop,
    frameTop: frame.top,
    clearance,
    indent: needed ? size + design.space.lg : 0,
  });
}

type BackKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented'
> & { target: EventTarget | null };

/** Web: Escape (outside text fields, no dialog or sheet open) and Alt+Left act like the back control. */
export function isWebBackKey(event: BackKeyEvent, modalOpen: boolean): boolean {
  if (event.defaultPrevented || modalOpen || event.ctrlKey || event.metaKey) return false;
  if (event.key === 'ArrowLeft') return event.altKey && !event.shiftKey;
  if (event.key !== 'Escape' || event.altKey || event.shiftKey) return false;
  const target = event.target as HTMLElement | null;
  return !(target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? ''));
}

export function useWebBackKeys(enabled: boolean, onBack: () => void) {
  const back = useEffectEvent(onBack);
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web') return;
    const listener = (event: KeyboardEvent) => {
      // React Native Web renders every open Modal (Dialog, Sheet, drawers) with aria-modal.
      if (!isWebBackKey(event, !!document.querySelector('[aria-modal="true"]'))) return;
      event.preventDefault();
      back();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [enabled]);
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
  const focused = useIsFocused();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));
  useWebBackKeys(needed && focused, goBack);
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
        onPress={goBack}
      />
    </View>
  );
}
