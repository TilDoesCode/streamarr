import { CircleAlert, CircleCheck, Info, type LucideIcon } from 'lucide-react-native';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { Easing, FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass } from '@/components/glass';
import { Text } from '@/components/ui/text';
import { useShell } from '@/shell/use-shell';
import { colors, easing, fonts, motion, useDesign } from '@/theme';

export type ToastTone = 'info' | 'success' | 'error';
export type ToastInput = { message: string; tone?: ToastTone; duration?: number };
type ToastItem = ToastInput & { id: number };

const TONES: Record<ToastTone, { icon: LucideIcon; color: string }> = {
  info: { icon: Info, color: colors.info.DEFAULT },
  success: { icon: CircleCheck, color: colors.success.DEFAULT },
  error: { icon: CircleAlert, color: colors.danger.DEFAULT },
};

/** TV: read from the couch, so a toast stays at least this long. */
const TV_MIN_DURATION = 6000;

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
      Platform.isTV
        ? Math.max(toast.duration ?? motion.toast, TV_MIN_DURATION)
        : (toast.duration ?? motion.toast)
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
  // Wide pointer layouts keep the toast in the corner, beside the content column.
  const corner = design.formFactor === 'desktop-web' || design.formFactor === 'tablet';
  return (
    <View
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space.lg,
        alignItems: corner ? 'flex-end' : 'center',
        paddingHorizontal: design.layout.gutter,
      }}>
      {toast ? <ToastView key={toast.id} toast={toast} /> : null}
    </View>
  );
}

function ToastView({ toast }: { toast: ToastItem }) {
  const design = useDesign();
  const { large, s } = useShell();
  const tone = TONES[toast.tone ?? 'info'];
  const IconComponent = tone.icon;
  if (large)
    return (
      <Animated.View
        entering={ENTER}
        exiting={EXIT}
        accessible
        role="alert"
        accessibilityLiveRegion="polite"
        focusable={false}
        style={{ maxWidth: s(880), boxShadow: design.shadow.overlay, borderRadius: s(24) }}>
        <Glass intensity="strong" tint={tone.color} radius={s(24)}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: s(18),
              paddingVertical: s(20),
              paddingLeft: s(24),
              paddingRight: s(32),
            }}>
            <View
              style={{
                width: s(44),
                height: s(44),
                borderRadius: s(22),
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: tone.color,
              }}>
              <IconComponent size={s(26)} color={colors.foreground.DEFAULT} strokeWidth={2.5} />
            </View>
            <Text
              style={{
                flexShrink: 1,
                fontFamily: fonts.bodyMedium,
                fontSize: s(24),
                lineHeight: s(32),
                color: colors.foreground.DEFAULT,
              }}>
              {toast.message}
            </Text>
          </View>
        </Glass>
      </Animated.View>
    );
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
