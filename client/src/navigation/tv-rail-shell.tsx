import { useRouter } from 'expo-router';
import { TabSlot, useTabsWithTriggers } from 'expo-router/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { FocusGuide, Focusable, useBackHandler, useFocusState } from '@/components/focus';
import { Avatar } from '@/components/ui/avatar';
import { Dialog } from '@/components/ui/dialog';
import { colors, DesignGutter, easing, motion, useDesign } from '@/theme';

import { ScreenFocusProvider, useScreenFocusHost } from './screen-focus';
import { TAB_TRIGGERS, TABS, type TabSpec } from './tabs';
import { tvBackAction } from './tv-back';

// Authored in Android TV dp (960 wide), scaled by design.px.
const RAIL = { collapsed: 80, expanded: 240, item: 48, itemHeight: 40, gap: 10, contentGutter: 20 };

const EASE_OUT = Easing.bezier(...easing.out);

type Metrics = { item: number; itemHeight: number; wideItem: number; icon: number };

/** Android TV shell: a collapsed icon rail that expands while focused, beside the tab content. */
export function TvRailShell() {
  // Compiled memoization would keep NavigationContent (and the TabSlot) on stale state after a push.
  'use no memo';
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const { state, navigation, NavigationContent } = useTabsWithTriggers({
    triggers: TAB_TRIGGERS,
    backBehavior: 'firstRoute',
  });
  const activeName = state.routes[state.index]?.name;
  const railFocused = useRef(false);
  const expanded = useSharedValue(0);
  const [exitOpen, setExitOpen] = useState(false);
  const screens = useScreenFocusHost();

  const setRailFocused = (focused: boolean) => {
    railFocused.current = focused;
    expanded.set(
      withTiming(focused ? 1 : 0, {
        duration: focused ? motion.enter : motion.exit,
        easing: EASE_OUT,
      })
    );
  };

  useBackHandler(() => {
    const action = tvBackAction({
      railFocused: railFocused.current,
      canGoBack: router.canGoBack(),
    });
    if (action === 'closeRail') screens.focusActive();
    if (action === 'confirmExit') setExitOpen(true);
    return action !== 'navigate';
  });

  const select = (tab: TabSpec) => {
    if (tab.name === activeName) {
      screens.focusActive();
      return;
    }
    screens.focusNext();
    navigation.dispatch({ type: 'JUMP_TO', payload: { name: tab.name } });
  };

  const railWidth = design.px(RAIL.collapsed);
  return (
    <NavigationContent>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View testID="tv-content" style={{ flex: 1, marginLeft: railWidth }}>
          <DesignGutter gutter={design.px(RAIL.contentGutter)}>
            <ScreenFocusProvider value={screens.host}>
              <TabSlot />
            </ScreenFocusProvider>
          </DesignGutter>
        </View>
        <Rail
          activeName={activeName}
          expanded={expanded}
          onSelect={select}
          onFocusChange={setRailFocused}
        />
      </View>
      <Dialog
        testID="exit-dialog"
        open={exitOpen}
        onClose={() => setExitOpen(false)}
        title={t('exit.title')}
        actions={[
          {
            label: t('common.cancel'),
            variant: 'secondary',
            preferred: true,
            onPress: () => setExitOpen(false),
          },
          { label: t('exit.confirm'), variant: 'primary', onPress: () => BackHandler.exitApp() },
        ]}
      />
    </NavigationContent>
  );
}

function Rail({
  activeName,
  expanded,
  onSelect,
  onFocusChange,
}: {
  activeName: string | undefined;
  expanded: SharedValue<number>;
  onSelect: (tab: TabSpec) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const reduced = useReducedMotion();
  const { account } = useActiveAccount();
  const width = design.px(RAIL.collapsed);
  const wide = design.px(RAIL.expanded);
  const item = design.px(RAIL.item);
  const metrics: Metrics = {
    item,
    itemHeight: design.px(RAIL.itemHeight),
    wideItem: wide - (width - item),
    icon: design.layout.iconSize.lg,
  };
  const slide = (wide - width) / 4;

  const scrimStyle = useAnimatedStyle(() => ({ opacity: expanded.get() }));
  const panelStyle = useAnimatedStyle(
    () => ({
      opacity: expanded.get(),
      transform: [{ translateX: reduced ? 0 : interpolate(expanded.get(), [0, 1], [-slide, 0]) }],
    }),
    [reduced, slide]
  );
  const nameStyle = useAnimatedStyle(() => ({ opacity: expanded.get() }));

  return (
    <>
      <Animated.View
        style={[
          {
            pointerEvents: 'none',
            position: 'absolute',
            inset: 0,
            backgroundColor: colors.scrim.DEFAULT,
          },
          scrimStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            pointerEvents: 'none',
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: wide,
            backgroundColor: colors.surface.DEFAULT,
            boxShadow: design.shadow.overlay,
          },
          panelStyle,
        ]}
      />
      <View
        role="navigation"
        aria-label={t('tabs.navigation')}
        style={{
          pointerEvents: 'box-none',
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width,
          paddingVertical: design.layout.edgeVertical,
          alignItems: 'center',
        }}>
        <View style={{ width: item, height: item, alignItems: 'center', justifyContent: 'center' }}>
          <Avatar name={account.displayName} color={account.color} size={design.px(32)} />
          <Animated.Text
            numberOfLines={1}
            style={[
              design.type.callout,
              {
                position: 'absolute',
                left: item + design.space.xs,
                width: metrics.wideItem - item - design.space.sm,
                color: colors.foreground.muted,
              },
              nameStyle,
            ]}>
            {account.displayName}
          </Animated.Text>
        </View>
        <FocusGuide
          testID="tv-rail"
          remember
          trap={['up', 'down', 'left']}
          onFocusEnter={() => onFocusChange(true)}
          onFocusLeave={() => onFocusChange(false)}
          style={{ flex: 1, justifyContent: 'center', gap: design.px(RAIL.gap) }}>
          {TABS.map((tab) => (
            <RailItem
              key={tab.name}
              tab={tab}
              label={t(`tabs.${tab.id}`)}
              active={tab.name === activeName}
              expanded={expanded}
              metrics={metrics}
              onPress={() => onSelect(tab)}
            />
          ))}
        </FocusGuide>
      </View>
    </>
  );
}

function RailItem({
  tab,
  label,
  active,
  expanded,
  metrics,
  onPress,
}: {
  tab: TabSpec;
  label: string;
  active: boolean;
  expanded: SharedValue<number>;
  metrics: Metrics;
  onPress: () => void;
}) {
  return (
    <Focusable
      testID={`rail-${tab.id}`}
      role="tab"
      aria-selected={active}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ width: metrics.item, height: metrics.itemHeight }}>
      <RailItemSurface
        tab={tab}
        label={label}
        active={active}
        expanded={expanded}
        metrics={metrics}
      />
    </Focusable>
  );
}

function RailItemSurface({
  tab,
  label,
  active,
  expanded,
  metrics,
}: {
  tab: TabSpec;
  label: string;
  active: boolean;
  expanded: SharedValue<number>;
  metrics: Metrics;
}) {
  const design = useDesign();
  const { focus } = useFocusState();
  const { item, itemHeight, wideItem, icon } = metrics;
  const rest = active ? colors.foreground.DEFAULT : colors.foreground.muted;
  const restBackground = active ? colors.secondary.DEFAULT : colors.scrim.clear;

  const pillStyle = useAnimatedStyle(
    () => ({
      width: interpolate(expanded.get(), [0, 1], [item, wideItem]),
      backgroundColor: interpolateColor(
        focus.get(),
        [0, 1],
        [restBackground, colors.primary.DEFAULT]
      ),
    }),
    [item, wideItem, restBackground]
  );
  const labelStyle = useAnimatedStyle(
    () => ({
      opacity: expanded.get(),
      color: interpolateColor(focus.get(), [0, 1], [rest, colors.primary.foreground]),
    }),
    [rest]
  );
  const restIconStyle = useAnimatedStyle(() => ({ opacity: 1 - focus.get() }));
  const focusIconStyle = useAnimatedStyle(() => ({ opacity: focus.get() }));
  const Icon = tab.icon;

  return (
    <>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            height: itemHeight,
            borderRadius: itemHeight / 2,
            borderCurve: 'continuous',
          },
          pillStyle,
        ]}
      />
      <View
        style={{ width: item, height: itemHeight, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: icon, height: icon }}>
          <Animated.View style={[{ position: 'absolute' }, restIconStyle]}>
            <Icon size={icon} color={rest} strokeWidth={2.25} />
          </Animated.View>
          <Animated.View style={[{ position: 'absolute' }, focusIconStyle]}>
            <Icon size={icon} color={colors.primary.foreground} strokeWidth={2.25} />
          </Animated.View>
        </View>
      </View>
      <Animated.Text
        numberOfLines={1}
        style={[
          design.type.label,
          {
            position: 'absolute',
            left: item,
            top: (itemHeight - design.type.label.lineHeight) / 2,
            width: wideItem - item - design.space.md,
          },
          labelStyle,
        ]}>
        {label}
      </Animated.Text>
    </>
  );
}
