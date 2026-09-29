import { CircleAlert, CircleCheck, Info, type LucideIcon } from 'lucide-react-native';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { Easing, FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { colors, easing, motion, useDesign } from '@/theme';

export type ToastTone = 'info' | 'success' | 'error';
export type ToastInput = { message: string; tone?: ToastTone; duration?: number };
type ToastItem = ToastInput & { id: number };

const TONES: Record<ToastTone, { icon: LucideIcon; color: string }> = {
  info: { icon: Info, color: colors.info.DEFAULT },
  success: { icon: CircleCheck, color: colors.success.DEFAULT },
  error: { icon: CircleAlert, color: colors.danger.DEFAULT },
};

const ENTER = FadeInDown.duration(motion.enter).easing(Easing.bezier(...easing.out));
const EXIT = FadeOutDown.duration(motion.exit);

const ToastContext = createContext<{ show: (toast: ToastInput) => void } | null>(null);

export function useToast() {
  const context = use(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/** One transient, non-focusable message at a time; a new toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const nextId = useRef(0);
  const [api] = useState(() => ({
    show: (input: ToastInput) => {
      nextId.current += 1;
      setToast({ ...input, id: nextId.current });
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(input.message);
    },
  }));

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      toast.duration ?? motion.toast
    );
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext value={api}>
      {children}
      <ToastViewport toast={toast} />
    </ToastContext>
  );
}

function ToastViewport({ toast }: { toast: ToastItem | null }) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        pointerEvents: 'box-none',
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space.lg,
        alignItems: 'center',
        paddingHorizontal: design.layout.gutter,
      }}>
      {toast ? <ToastView key={toast.id} toast={toast} /> : null}
    </View>
  );
}

function ToastView({ toast }: { toast: ToastItem }) {
  const design = useDesign();
  const tone = TONES[toast.tone ?? 'info'];
  const IconComponent = tone.icon;
  return (
    <Animated.View
      entering={ENTER}
      exiting={EXIT}
      accessible
      role="alert"
      accessibilityLiveRegion="polite"
      focusable={false}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: design.space.md,
        maxWidth: design.px(520),
        paddingVertical: design.space.md,
        paddingHorizontal: design.space.lg,
        borderRadius: design.radius.lg,
        borderCurve: 'continuous',
        backgroundColor: colors.surface.overlay,
        borderWidth: 1,
        borderColor: colors.border,
        boxShadow: design.shadow.overlay,
      }}>
      <IconComponent size={design.layout.iconSize.md} color={tone.color} strokeWidth={2.25} />
      <Text variant="callout" style={{ flexShrink: 1 }}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}
