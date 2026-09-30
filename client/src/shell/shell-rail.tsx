import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { FocusGuide, Focusable, FocusLift, useFocusState } from '@/components/focus';
import { Glass } from '@/components/glass';
import { Avatar } from '@/components/ui/avatar';
import { Text } from '@/components/ui/text';
import { withAlpha } from '@/lib/color';
import { TABS, type TabSpec } from '@/navigation/tabs';
import { colors, fonts, useDesign } from '@/theme';

import { BrandMark } from './brand-mark';
import { SHELL } from './shell-metrics';
import { useShell } from './use-shell';

type KeyEvent = { key: string; preventDefault: () => void };
type Click = Partial<Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button'>> & {
  preventDefault?: () => void;
};

export type ShellRailProps = {
  activeName: string | undefined;
  onSelect: (tab: TabSpec) => void;
  /** TV: rail focus enters/leaves (back chain). */
  onFocusChange?: (focused: boolean) => void;
};

/** Glass navigation rail of the large-screen shell: brand mark, tabs, settings and the active profile. */
export function ShellRail({ activeName, onSelect, onFocusChange }: ShellRailProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  const router = useRouter();
  const { account } = useActiveAccount();
  const items = useRef<(View | null)[]>([]);
  // Entering the rail (TV) lands on the active tab, not on the last focused item.
  const [activeNode, setActiveNode] = useState<View | null>(null);
  const open = useSharedValue(0);
  const scrimStyle = useAnimatedStyle(() => ({ opacity: open.get() }));
  const setOpen = (focused: boolean) => {
    open.set(withTiming(focused ? 1 : 0, { duration: 200 }));
    onFocusChange?.(focused);
  };
  const { rail } = SHELL;
  const main = TABS.filter((tab) => tab.id !== 'settings');
  const settings = TABS.find((tab) => tab.id === 'settings')!;

  // Web: roving arrow-key focus between the rail items (Tab still reaches each one).
  const onKeyDown = (event: KeyEvent) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const list = items.current.filter(Boolean) as unknown as HTMLElement[];
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };

  const item = (tab: TabSpec, index: number) => (
    <RailItem
      key={tab.name}
      tab={tab}
      active={tab.name === activeName}
      onPress={() => onSelect(tab)}
      itemRef={(view) => {
        items.current[index] = view;
        if (tab.name === activeName) setActiveNode(view);
      }}
    />
  );

  return (
    <View
      testID="shell-rail"
      role="navigation"
      aria-label={t('tabs.navigation')}
      {...(Platform.OS === 'web' ? { onKeyDown } : {})}
      style={{
        pointerEvents: 'box-none',
        position: 'absolute',
        left: s(rail.inset),
        top: s(rail.top),
        bottom: s(rail.top),
        width: s(rail.pill),
        zIndex: 2,
      }}>
      {design.isTV ? (
        // TV: the focused rail dims the content beside it so its labels never mix with row headings.
        <Animated.View
          style={[
            {
              pointerEvents: 'none',
              position: 'absolute',
              left: -s(rail.inset),
              top: -s(rail.top),
              bottom: -s(rail.top),
              width: s(640),
            },
            scrimStyle,
          ]}>
          <LinearGradient
            colors={[withAlpha(colors.background, 0.92), withAlpha(colors.background, 0)]}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      ) : null}
      <Glass
        intensity="subtle"
        radius={s(rail.pill / 2)}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
      <View style={{ alignItems: 'center', paddingTop: s(28), paddingBottom: s(36) }}>
        <BrandMark size={s(rail.mark)} />
      </View>
      <FocusGuide
        testID="tv-rail"
        remember={false}
        destinations={design.isTV && activeNode ? [activeNode] : undefined}
        trap={design.isTV ? ['up', 'down', 'left'] : undefined}
        onFocusEnter={() => setOpen(true)}
        onFocusLeave={() => setOpen(false)}
        style={{ flex: 1, alignItems: 'center', gap: s(rail.gap), paddingBottom: s(20) }}>
        {main.map(item)}
        <View style={{ flex: 1 }} />
        {item(settings, main.length)}
        <Focusable
          ref={(view) => {
            items.current[main.length + 1] = view;
          }}
          testID="web-profile"
          role="button"
          accessibilityLabel={t('settings.account.switchNamed', { name: account.displayName })}
          onPress={() => router.push('/profiles')}
          style={{ marginTop: s(8) }}>
          <FocusLift kind="button" radius={s(rail.avatar / 2)}>
            <Avatar name={account.displayName} color={account.color} size={s(rail.avatar)} round />
          </FocusLift>
          <RailLabel label={account.displayName} size={s(rail.avatar)} />
        </Focusable>
      </FocusGuide>
    </View>
  );
}

function RailItem({
  tab,
  active,
  onPress,
  itemRef,
}: {
  tab: TabSpec;
  active: boolean;
  onPress: () => void;
  itemRef: (view: View | null) => void;
}) {
  const { t } = useTranslation();
  const { s } = useShell();
  const label = t(`tabs.${tab.id}`);
  const size = s(SHELL.rail.item);
  // react-native-web renders a View with `href` as <a>: middle-click and "open in new tab" work natively.
  const anchor = Platform.OS === 'web' ? { href: tab.href } : {};
  return (
    <Focusable
      ref={itemRef}
      {...anchor}
      testID={`nav-${tab.id}`}
      role={Platform.OS === 'web' ? 'link' : 'tab'}
      aria-current={active ? 'page' : undefined}
      aria-selected={active}
      accessibilityLabel={label}
      onPress={(event) => {
        const click = event as unknown as Click;
        if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey || !!click.button)
          return;
        click.preventDefault?.();
        onPress();
      }}
      style={{ width: size, height: size }}>
      <FocusLift kind="button" radius={size / 2}>
        <RailIcon tab={tab} active={active} size={size} />
      </FocusLift>
      <RailLabel label={label} size={size} />
    </Focusable>
  );
}

function RailIcon({ tab, active, size }: { tab: TabSpec; active: boolean; size: number }) {
  const { s } = useShell();
  const { hover } = useFocusState();
  const rest = active ? colors.primary.DEFAULT : colors.scrim.clear;
  const lit = active ? colors.primary.DEFAULT : colors.secondary.DEFAULT;
  const discStyle = useAnimatedStyle(
    () => ({ backgroundColor: interpolateColor(hover.get(), [0, 1], [rest, lit]) }),
    [rest, lit]
  );
  const Icon = tab.icon;
  const tone = active
    ? colors.primary.foreground
    : Platform.isTV
      ? colors.foreground.mutedTv
      : colors.foreground.muted;
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
        },
        discStyle,
      ]}>
      <Icon size={s(28)} color={tone} strokeWidth={2.25} />
    </Animated.View>
  );
}

/** Label beside a focused (TV) or hovered (web) rail item; an overlay, so the content never shifts. */
function RailLabel({ label, size }: { label: string; size: number }) {
  const { s } = useShell();
  const { focus, hover } = useFocusState();
  const style = useAnimatedStyle(() => ({ opacity: Math.max(focus.get(), hover.get()) }));
  return (
    <Animated.View
      style={[
        {
          pointerEvents: 'none',
          position: 'absolute',
          left: size + s(20),
          top: (size - s(44)) / 2,
          width: s(360),
          alignItems: 'flex-start',
        },
        style,
      ]}>
      <View
        style={{
          height: s(44),
          justifyContent: 'center',
          paddingHorizontal: s(18),
          borderRadius: s(22),
          backgroundColor: colors.glass.solid,
          borderWidth: 1,
          borderColor: colors.glass.border,
        }}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: fonts.bodySemiBold,
            fontSize: s(20),
            lineHeight: s(26),
            color: colors.foreground.DEFAULT,
          }}>
          {label}
        </Text>
      </View>
    </Animated.View>
  );
}
