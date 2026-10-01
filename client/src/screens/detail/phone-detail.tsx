import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { ArrowLeft, ChevronUp, Info, type LucideIcon } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Focusable, FocusGuide, FocusLift } from '@/components/focus';
import { Glass, GlassButton } from '@/components/glass';
import { HeroTitle } from '@/components/media/hero';
import { Scrim } from '@/components/media/scrim';
import { SpecLabels, type CatalogSpec } from '@/components/spec';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { withAlpha } from '@/lib/color';
import { colors, fonts, useDesign } from '@/theme';

import type { Credit } from './large-detail';

export type PhoneAction = {
  testID: string;
  icon: LucideIcon;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
};

export type PhoneDetailProps = {
  testID: string;
  kindLabel: string;
  title: string;
  logoUrl?: string | null;
  backdropUrl?: string | null;
  tint?: string | null;
  facts: string[];
  certification?: string | null;
  spec?: CatalogSpec | null;
  /** Best available vs device spec when they differ. */
  specNote?: string | null;
  overview?: string | null;
  credits?: Credit[];
  /** Resume bar / up-next line under the facts. */
  status?: ReactNode;
  /** Full-width Play (and Start over). */
  play?: ReactNode;
  /** The glass "Version" card that opens the sheet. */
  version?: ReactNode;
  /** Small icon row under the synopsis (Watched); "Details" is added here. */
  actions?: PhoneAction[];
  loading?: boolean;
  /** Seasons and episodes (series). */
  children?: ReactNode;
};

/** Phone detail (Aurora C-phone): art on top, glass back button, copy, full-width Play, Version card, synopsis. */
export function PhoneDetail({
  testID,
  kindLabel,
  title,
  logoUrl,
  backdropUrl,
  tint,
  facts,
  certification,
  spec,
  specNote,
  overview,
  credits,
  status,
  play,
  version,
  actions = [],
  loading = false,
  children,
}: PhoneDetailProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.set(event.contentOffset.y);
  });
  const { width, height } = design.window;
  const gutter = design.layout.gutter;
  const artHeight = Math.min(width * 1.15, height * 0.62);
  const copyTop = Math.max(artHeight * 0.58, insets.top + HEADER_HEIGHT + design.space.md);
  // Title tint washed under the copy; the art fades into the same colour.
  const wash = withAlpha(tint ?? colors.accent.DEFAULT, 0.22);
  const hasMore = !!overview || !!credits?.length;
  const row: PhoneAction[] = [
    ...actions,
    ...(hasMore
      ? [
          {
            testID: `${testID}-details`,
            icon: expanded ? ChevronUp : Info,
            label: t(expanded ? 'detail.lessDetails' : 'detail.details'),
            selected: expanded,
            onPress: () => setExpanded((value) => !value),
          },
        ]
      : []),
  ];

  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: colors.background }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, design.space.lg) + 96 }}>
        <LinearGradient
          colors={[wash, wash, colors.scrim.clear]}
          locations={[0, artHeight / (artHeight + 640), 1]}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, height: artHeight + 640 }}
        />
        <View style={{ height: artHeight }}>
          {backdropUrl ? (
            <Image
              source={{ uri: backdropUrl }}
              contentFit="cover"
              style={StyleSheet.absoluteFill}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <Scrim
            direction="up"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' }}
          />
          <Scrim
            direction="up"
            color={wash}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' }}
          />
        </View>
        <View
          style={{
            marginTop: copyTop - artHeight,
            paddingHorizontal: gutter,
            gap: design.space.md,
          }}>
          {loading ? (
            <View testID="hero-skeleton" aria-busy style={{ gap: design.space.md }}>
              <Skeleton width={90} height={28} radius={14} />
              <Skeleton width="80%" height={40} radius={8} />
              <Skeleton width="50%" height={18} radius={6} />
              <Skeleton height={52} radius={26} />
              <Skeleton height={96} radius={20} />
            </View>
          ) : (
            <>
              <TypePill label={kindLabel} tint={tint} />
              <HeroTitle
                title={title}
                logoUri={logoUrl}
                logoHeight={72}
                logoWidth={width * 0.7}
                textStyle={{
                  fontFamily: fonts.displayBold,
                  fontSize: 36,
                  lineHeight: 40,
                  letterSpacing: -0.8,
                  color: colors.foreground.DEFAULT,
                }}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: design.space.sm,
                }}>
                {facts.length ? (
                  <Text variant="callout" tone="muted" numberOfLines={1}>
                    {facts.join(' · ')}
                  </Text>
                ) : null}
                {certification ? (
                  <View
                    testID="detail-certification"
                    style={{
                      borderWidth: 1.5,
                      borderColor: colors.foreground.muted,
                      borderRadius: 6,
                      paddingHorizontal: 5,
                    }}>
                    <Text variant="caption" tone="muted" style={{ fontFamily: fonts.bodySemiBold }}>
                      {certification}
                    </Text>
                  </View>
                ) : null}
                <SpecLabels spec={spec} max={3} />
              </View>
              {specNote ? (
                <Text testID="detail-spec-note" variant="caption" tone="muted" numberOfLines={2}>
                  {specNote}
                </Text>
              ) : null}
              {status}
              <FocusGuide remember style={{ gap: design.space.sm, marginTop: design.space.xs }}>
                {play}
              </FocusGuide>
              {version}
              {overview ? (
                <Text
                  testID={`${testID}-overview`}
                  variant="body"
                  numberOfLines={expanded ? undefined : 4}>
                  {overview}
                </Text>
              ) : null}
              {expanded && credits?.length ? (
                <View style={{ gap: design.space.xs }}>
                  {credits.map((credit) => (
                    <View key={credit.label} style={{ flexDirection: 'row', gap: design.space.md }}>
                      <Text variant="callout" tone="muted" style={{ width: 88 }}>
                        {credit.label}
                      </Text>
                      <Text variant="callout" style={{ flex: 1 }}>
                        {credit.value}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {row.length ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                  {row.map((action) => (
                    <ActionItem key={action.testID} {...action} />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
        {loading ? null : children}
      </Animated.ScrollView>
      <Scrim
        direction="down"
        color={withAlpha(colors.background, 0.55)}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: insets.top + 32 }}
      />
      {Platform.OS === 'ios' ? null : (
        <HeaderStrip
          title={title}
          scrollY={scrollY}
          fadeEnd={artHeight - insets.top - HEADER_HEIGHT}
        />
      )}
      {Platform.OS === 'ios' ? null : <BackButton top={insets.top + (HEADER_HEIGHT - 44) / 2} />}
    </View>
  );
}

const HEADER_HEIGHT = 60;

/** Android and web: glass strip with the title that fades in once the art has scrolled away. */
function HeaderStrip({
  title,
  scrollY,
  fadeEnd,
}: {
  title: string;
  scrollY: SharedValue<number>;
  fadeEnd: number;
}) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.get(), [fadeEnd - 80, fadeEnd], [0, 1], 'clamp'),
  }));
  return (
    <Animated.View
      testID="detail-header-strip"
      pointerEvents="none"
      style={[{ position: 'absolute', left: 0, right: 0, top: 0 }, fade]}>
      <View style={{ height: insets.top, backgroundColor: colors.background }} />
      <View
        style={[
          StyleSheet.absoluteFill,
          { top: insets.top, backgroundColor: withAlpha(colors.background, 0.9) },
        ]}
      />
      <Glass
        radius={0}
        intensity="strong"
        style={{
          height: HEADER_HEIGHT,
          justifyContent: 'center',
          paddingLeft: design.layout.gutter + 44 + design.space.md,
          paddingRight: design.layout.gutter,
        }}>
        <Text variant="subheading" numberOfLines={1}>
          {title}
        </Text>
      </Glass>
    </Animated.View>
  );
}

function TypePill({ label, tint }: { label: string; tint?: string | null }) {
  return (
    <Glass
      radius={14}
      intensity="subtle"
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 28,
        paddingHorizontal: 12,
      }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: tint ?? colors.accent.DEFAULT,
        }}
      />
      <Text variant="caption" style={{ fontFamily: fonts.bodyMedium }}>
        {label}
      </Text>
    </Glass>
  );
}

function ActionItem({
  testID,
  icon: Icon,
  label,
  accessibilityLabel,
  onPress,
  disabled,
  selected,
}: PhoneAction) {
  const design = useDesign();
  return (
    <Focusable
      testID={testID}
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-selected={selected}
      disabled={disabled}
      onPress={onPress}>
      <FocusLift kind="button" radius={design.radius.lg} style={{ opacity: disabled ? 0.4 : 1 }}>
        <View
          style={{
            alignItems: 'center',
            gap: design.space.xs,
            minWidth: 88,
            paddingVertical: design.space.sm,
          }}>
          <Icon size={22} color={colors.foreground.DEFAULT} strokeWidth={1.75} />
          <Text variant="caption" tone="muted">
            {label}
          </Text>
        </View>
      </FocusLift>
    </Focusable>
  );
}

/** Android and web: glass back button over the art (iOS keeps the native Liquid Glass header). */
function BackButton({ top }: { top: number }) {
  const { t } = useTranslation();
  const router = useRouter();
  const design = useDesign();
  return (
    <View style={{ position: 'absolute', top, left: design.layout.gutter }}>
      <GlassButton
        testID="detail-back"
        iconOnly
        size={44}
        icon={ArrowLeft}
        label={t('common.back')}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </View>
  );
}
