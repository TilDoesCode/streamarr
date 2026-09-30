import { useRouter } from 'expo-router';
import { TabSlot, useTabsWithTriggers } from 'expo-router/ui';
import { Clapperboard } from 'lucide-react-native';
import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { Focusable, FocusLift, useFocusState } from '@/components/focus';
import { Avatar } from '@/components/ui/avatar';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

import { TAB_TRIGGERS, TABS, type TabSpec } from './tabs';

/** Window width from which the web shell shows a sidebar instead of a top bar. */
export const SIDEBAR_MIN_WIDTH = 1200;

type KeyEvent = { key: string; preventDefault: () => void };

type Click = Partial<Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button'>> & {
  preventDefault?: () => void;
};

/** Web shell: a sidebar on wide windows, a top bar otherwise; arrow keys move between items. */
export function WebShell() {
  // Compiled memoization would keep NavigationContent (and the TabSlot) on stale state after a push.
  'use no memo';
  const design = useDesign();
  const router = useRouter();
  const { state, navigation, NavigationContent } = useTabsWithTriggers({
    triggers: TAB_TRIGGERS,
    // Every tab switch is a browser history entry, also when the tab was visited before.
    backBehavior: 'fullHistory',
  });
  const activeName = state.routes[state.index]?.name;
  const sidebar = design.window.width >= SIDEBAR_MIN_WIDTH;
  const items = useRef<(View | null)[]>([]);

  const select = (tab: TabSpec) => {
    // The active tab again: back to its first screen.
    if (tab.name === activeName) router.navigate(tab.href);
    else navigation.dispatch({ type: 'JUMP_TO', payload: { name: tab.name } });
  };

  return (
    <NavigationContent>
      <View
        style={{
          flex: 1,
          flexDirection: sidebar ? 'row' : 'column',
          backgroundColor: colors.background,
        }}>
        {sidebar ? (
          <Sidebar activeName={activeName} items={items} onSelect={select} />
        ) : (
          <TopBar activeName={activeName} items={items} onSelect={select} />
        )}
        <View role="main" style={{ flex: 1 }}>
          <TabSlot />
        </View>
      </View>
    </NavigationContent>
  );
}

type BarProps = {
  activeName: string | undefined;
  items: RefObject<(View | null)[]>;
  onSelect: (tab: TabSpec) => void;
};

// Roving arrow-key focus between the navigation items (Tab still reaches each one).
function arrowKeys(items: RefObject<(View | null)[]>, previous: string, next: string) {
  return {
    onKeyDown: (event: KeyEvent) => {
      if (event.key !== previous && event.key !== next) return;
      const list = items.current.filter(Boolean) as unknown as HTMLElement[];
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === next ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    },
  };
}

function Sidebar({ activeName, items, onSelect }: BarProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const main = TABS.filter((tab) => tab.id !== 'settings');
  const settings = TABS.filter((tab) => tab.id === 'settings');
  return (
    <View
      testID="web-sidebar"
      role="navigation"
      aria-label={t('tabs.navigation')}
      {...arrowKeys(items, 'ArrowUp', 'ArrowDown')}
      style={{
        width: design.px(248),
        paddingVertical: design.space['2xl'],
        paddingHorizontal: design.space.lg,
        gap: design.space['2xl'],
        backgroundColor: colors.surface.DEFAULT,
        borderRightWidth: 1,
        borderRightColor: colors.border,
      }}>
      <Brand />
      <View style={{ flex: 1, gap: design.space.xs }}>
        {main.map((tab, index) => (
          <NavItem
            key={tab.name}
            tab={tab}
            active={tab.name === activeName}
            onPress={() => onSelect(tab)}
            ref={(view) => {
              items.current[index] = view;
            }}
          />
        ))}
      </View>
      <View style={{ gap: design.space.md }}>
        <ProfileChip />
        {settings.map((tab) => (
          <NavItem
            key={tab.name}
            tab={tab}
            active={tab.name === activeName}
            onPress={() => onSelect(tab)}
            ref={(view) => {
              items.current[main.length] = view;
            }}
          />
        ))}
      </View>
    </View>
  );
}

function TopBar({ activeName, items, onSelect }: BarProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const compact = design.window.width < 560;
  return (
    <View
      testID="web-topbar"
      role="navigation"
      aria-label={t('tabs.navigation')}
      {...arrowKeys(items, 'ArrowLeft', 'ArrowRight')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: design.space.lg,
        height: design.px(64),
        paddingHorizontal: design.layout.gutter,
        backgroundColor: colors.surface.DEFAULT,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}>
      {compact ? null : <Brand />}
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: design.space.xs }}>
        {TABS.map((tab, index) => (
          <NavItem
            key={tab.name}
            tab={tab}
            active={tab.name === activeName}
            compact={compact}
            onPress={() => onSelect(tab)}
            ref={(view) => {
              items.current[index] = view;
            }}
          />
        ))}
      </View>
      <ProfileChip compact />
    </View>
  );
}

function Brand() {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
      <Clapperboard
        size={design.layout.iconSize.lg}
        color={colors.accent.DEFAULT}
        strokeWidth={2.25}
      />
      <Text variant="subheading">{t('app.name')}</Text>
    </View>
  );
}

/** Current profile; opens "Who's watching?" to switch. */
function ProfileChip({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const { account } = useActiveAccount();
  return (
    <Focusable
      testID="web-profile"
      role="button"
      accessibilityLabel={t('settings.account.switchNamed', { name: account.displayName })}
      onPress={() => router.push('/profiles')}>
      <FocusLift kind="button" radius={design.radius.md}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: design.space.sm,
            padding: design.space.xs,
          }}>
          <Avatar name={account.displayName} color={account.color} size={design.px(32)} />
          {compact ? null : (
            <Text variant="callout" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {account.displayName}
            </Text>
          )}
        </View>
      </FocusLift>
    </Focusable>
  );
}

function NavItem({
  tab,
  active,
  compact = false,
  onPress,
  ref,
}: {
  tab: TabSpec;
  active: boolean;
  compact?: boolean;
  onPress: () => void;
  ref: (view: View | null) => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const label = t(`tabs.${tab.id}`);
  // react-native-web renders a View with `href` as <a>: Enter, middle-click and "open in new tab" work natively.
  const anchor: { href: string } = { href: tab.href };
  return (
    <Focusable
      ref={ref}
      {...anchor}
      testID={`nav-${tab.id}`}
      role="link"
      aria-current={active ? 'page' : undefined}
      accessibilityLabel={label}
      onPress={(event) => {
        const click = event as unknown as Click;
        // Modifier or middle clicks: the browser opens the link in a new tab or window.
        if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey || !!click.button)
          return;
        click.preventDefault?.();
        onPress();
      }}>
      <FocusLift kind="button" radius={design.radius.md}>
        <NavItemSurface tab={tab} label={label} active={active} compact={compact} />
      </FocusLift>
    </Focusable>
  );
}

function NavItemSurface({
  tab,
  label,
  active,
  compact,
}: {
  tab: TabSpec;
  label: string;
  active: boolean;
  compact: boolean;
}) {
  const design = useDesign();
  const { hover, pressed } = useFocusState();
  const rest = active ? colors.accent.muted : colors.scrim.clear;
  const lit = active ? colors.accent.hover : colors.muted;
  const surfaceStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(Math.max(hover.get(), pressed.get()), [0, 1], [rest, lit]),
    }),
    [rest, lit]
  );
  const Icon = tab.icon;
  const tone = active ? colors.foreground.DEFAULT : colors.foreground.muted;
  return (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.md,
          height: design.layout.controlHeight.md,
          paddingHorizontal: compact ? design.space.md : design.space.lg,
          borderRadius: design.radius.md,
          borderCurve: 'continuous',
        },
        surfaceStyle,
      ]}>
      <Icon size={design.layout.iconSize.md} color={tone} strokeWidth={2.25} />
      {compact ? null : (
        <Text variant="label" style={{ color: tone }}>
          {label}
        </Text>
      )}
    </Animated.View>
  );
}
