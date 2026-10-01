import { useFocusEffect } from 'expo-router';
import type { TFunction } from 'i18next';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';

import type { components } from '@/api/schema';

import { useClearAmbient, useSetAmbient } from '@/components/ambient';
import {
  FocusGuide,
  ScrollRevealContext,
  useBackHandler,
  useFocusGlowRoom,
} from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { SpecLabels, type CatalogSpec } from '@/components/spec';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { CopyWash, HeroFade } from '@/shell/hero-fade';
import { ShellDesign } from '@/shell/shell-design';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';
import { META_SEPARATOR } from '@/lib/media-labels';

/** Mockup C-detail: glass version panel width and its margin to the screen edges (1920 × 1080 points). */
export const DETAIL = { panelWidth: 760, panelInset: 24, copyTop: 170, copyWidth: 840 } as const;

export type Credit = { label: string; value: string };

type Person = components['schemas']['TmdbPerson'];

const CREDIT_KINDS = [
  { key: 'director', types: ['director', 'directing'] },
  { key: 'writer', types: ['writer', 'writing', 'screenplay'] },
  { key: 'cast', types: ['cast', 'actor', 'acting'] },
] as const;

/** Director, writing and the first three cast members, in that order; kinds without people are left out. */
export function peopleCredits(
  people: readonly Person[] | null | undefined,
  t: TFunction
): Credit[] {
  const sorted = [...(people ?? [])].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
  return CREDIT_KINDS.flatMap(({ key, types }) => {
    const names = sorted
      .filter((person) => person.name && types.includes((person.type ?? '').toLowerCase() as never))
      .map((person) => person.name!)
      .slice(0, key === 'cast' ? 3 : 2);
    return names.length ? [{ label: t(`detail.credits.${key}`), value: names.join(', ') }] : [];
  });
}

/** "Versions · N": TV moves focus to the panel's entry card; web focuses it and highlights the panel. */
export function usePanelEntry() {
  const entryRef = useRef<View | null>(null);
  const [inside, setInside] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Set while the panel is loading another episode's versions: the entry card takes focus once it mounts.
  const pending = useRef(false);
  const focusEntry = (entry: View) => {
    if (Platform.isTV) return entry.requestTVFocus?.();
    // focusVisible: a programmatic focus shows the ring like keyboard focus (Chromium, Firefox).
    (entry as unknown as { focus?: (options?: object) => void }).focus?.({ focusVisible: true });
    setHighlight(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(false), 1200);
  };
  /** `later`: the panel is about to show other versions; focus the entry card when it appears. */
  const enter = (later = false) => {
    const entry = entryRef.current;
    if (later || !entry) pending.current = true;
    else focusEntry(entry);
  };
  const onEntry = (entry: View | null) => {
    if (!entry || !pending.current) return;
    pending.current = false;
    focusEntry(entry);
  };
  return { entryRef, inside, setInside, highlight, enter, onEntry };
}

export type LargeDetailProps = {
  testID: string;
  kindLabel: string;
  title: string;
  logoUrl?: string | null;
  backdropUrl?: string | null;
  tint?: string | null;
  tint2?: string | null;
  /** Title art highlight (sizes the TV glass of the rail over this page). */
  highlight?: string | null;
  facts: string[];
  certification?: string | null;
  spec?: CatalogSpec | null;
  /** Best available vs device spec when they differ. */
  specNote?: string | null;
  overview?: string | null;
  /** Resume bar or the next-episode line. */
  status?: ReactNode;
  actions: ReactNode;
  credits?: Credit[];
  /** Series: seasons and episodes under the copy. */
  children?: ReactNode;
  /** The version panel (always visible on the right). */
  panel: ReactNode;
  /** TV: focus is inside the panel; Back returns to the actions instead of leaving the screen. */
  panelFocused?: boolean;
  /** The title is still loading: skeleton copy. */
  loading?: boolean;
};

const TITLE_SAFE = 54;
const REVEAL_AFTER_RETURN_MS = 400;

/** Large shell (TV, web, tablet): title copy on the left over the artwork, the glass version panel on the right. */
export function LargeDetail(props: LargeDetailProps) {
  return (
    <ShellDesign>
      <LargeDetailLayout {...props} />
    </ShellDesign>
  );
}

function LargeDetailLayout({
  testID,
  kindLabel,
  title,
  logoUrl,
  backdropUrl,
  tint,
  tint2,
  highlight,
  facts,
  certification,
  spec,
  specNote,
  overview,
  status,
  actions,
  credits,
  children,
  panel,
  panelFocused = false,
  loading = false,
}: LargeDetailProps) {
  const { s } = useShell();
  const design = useDesign();
  const setAmbient = useSetAmbient();
  const clearAmbient = useClearAmbient();
  const actionsRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const glowRoom = useFocusGlowRoom();
  // TV: a focused episode box and its ring stay inside the title-safe area (54 of 1080 from the edges).
  const revealed = useRef<View | null>(null);
  const reveal = useCallback(
    (node: View | null) => {
      if (!design.isTV || !node) return;
      revealed.current = node;
      setTimeout(() =>
        node.measureInWindow((_x, y, _width, height) => {
          const margin = s(TITLE_SAFE) + glowRoom;
          const below = y + height + margin - design.window.height;
          const above = margin - y;
          const delta = below > 0 ? below : above > 0 ? -above : 0;
          if (delta) scrollRef.current?.scrollTo({ y: Math.max(0, scrollY.current + delta) });
        })
      );
    },
    [design.isTV, design.window.height, glowRoom, s]
  );
  // Back from the player: focus returns during the transition, so measure the restored box again once it settled.
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => reveal(revealed.current), REVEAL_AFTER_RETURN_MS);
      return () => clearTimeout(timer);
    }, [reveal])
  );
  useFocusEffect(
    useCallback(() => {
      const title = backdropUrl ? { image: backdropUrl, tint, tint2, highlight } : null;
      setAmbient(title);
      return () => clearAmbient(title);
    }, [setAmbient, clearAmbient, backdropUrl, tint, tint2, highlight])
  );
  useBackHandler(() => {
    actionsRef.current?.requestTVFocus?.();
    return true;
  }, design.isTV && panelFocused);

  const gutter = s(SHELL.row.left);
  // Tablet portrait: the panel goes under the copy instead of squeezing it.
  const portrait = !design.isTV && design.window.height > design.window.width;
  const text = (size: number, family: string = fonts.body) => ({
    fontFamily: family,
    fontSize: s(size),
    lineHeight: s(size * 1.45),
  });

  return (
    <View testID={testID} style={{ flex: 1 }}>
      <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
        <HeroFade>{backdropUrl ? <Artwork uri={backdropUrl} /> : null}</HeroFade>
        <View style={[StyleSheet.absoluteFill, { right: '35%' }]}>
          <CopyWash color={colors.scrim.DEFAULT} />
        </View>
      </View>
      <View style={{ flex: 1, flexDirection: portrait ? 'column' : 'row' }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          onScroll={(event) => (scrollY.current = event.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingLeft: gutter,
            paddingRight: s(48),
            paddingTop: s(DETAIL.copyTop),
            paddingBottom: s(96),
            gap: s(40),
          }}>
          {loading ? (
            <View testID="hero-skeleton" aria-busy style={{ gap: s(22) }}>
              <Skeleton width={s(120)} height={s(36)} radius={s(18)} />
              <Skeleton width={s(520)} height={s(120)} radius={s(12)} />
              <Skeleton width={s(420)} height={s(28)} radius={s(8)} />
              <Skeleton width={s(760)} height={s(96)} radius={s(8)} />
              <Skeleton width={s(360)} height={s(64)} radius={s(32)} />
            </View>
          ) : null}
          <View
            style={{
              maxWidth: s(DETAIL.copyWidth),
              gap: s(18),
              display: loading ? 'none' : 'flex',
            }}>
            <View
              style={{
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                gap: s(10),
                height: s(36),
                paddingHorizontal: s(16),
                borderRadius: s(18),
                backgroundColor: colors.glass.DEFAULT,
              }}>
              <View
                style={{
                  width: s(10),
                  height: s(10),
                  borderRadius: s(5),
                  backgroundColor: tint ?? colors.accent.DEFAULT,
                }}
              />
              <Text style={[text(18, fonts.bodyMedium), { color: colors.foreground.DEFAULT }]}>
                {kindLabel}
              </Text>
            </View>
            <HeroTitle
              title={title}
              logoUri={logoUrl}
              logoHeight={s(SHELL.logo.height - 30)}
              logoWidth={s(SHELL.logo.width)}
              textStyle={{
                fontFamily: fonts.displayBold,
                fontSize: s(96),
                lineHeight: s(100),
                letterSpacing: -s(2),
                color: colors.foreground.DEFAULT,
              }}
            />
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: s(14), flexWrap: 'wrap' }}>
              {facts.length ? (
                <Text numberOfLines={1} style={[text(24), { color: colors.foreground.muted }]}>
                  {facts.join(META_SEPARATOR)}
                </Text>
              ) : null}
              {certification ? (
                <View
                  testID="detail-certification"
                  style={{
                    borderWidth: s(1.5),
                    borderColor: colors.foreground.muted,
                    borderRadius: s(6),
                    paddingHorizontal: s(8),
                  }}>
                  <Text style={[text(18, fonts.bodySemiBold), { color: colors.foreground.muted }]}>
                    {certification}
                  </Text>
                </View>
              ) : null}
              <SpecLabels spec={spec} max={4} />
            </View>
            {specNote ? (
              <Text
                testID="detail-spec-note"
                numberOfLines={1}
                style={[text(22, fonts.bodySemiBold), { color: colors.foreground.muted }]}>
                {specNote}
              </Text>
            ) : null}
            {overview ? (
              <Text numberOfLines={4} style={[text(26), { color: colors.foreground.DEFAULT }]}>
                {overview}
              </Text>
            ) : null}
            {status}
            <FocusGuide ref={actionsRef} remember>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: s(16),
                  marginTop: s(12),
                  flexWrap: 'wrap',
                }}>
                {actions}
              </View>
            </FocusGuide>
            {credits?.length ? (
              <View style={{ gap: s(8), marginTop: s(20) }}>
                {credits.map((credit) => (
                  <View key={credit.label} style={{ flexDirection: 'row', gap: s(24) }}>
                    <Text
                      style={[text(20), { width: s(140), color: colors.foreground.muted }]}
                      numberOfLines={1}>
                      {credit.label}
                    </Text>
                    <Text style={[text(20, fonts.bodySemiBold), { flex: 1 }]} numberOfLines={1}>
                      {credit.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
          <ScrollRevealContext.Provider value={reveal}>{children}</ScrollRevealContext.Provider>
        </ScrollView>
        <View
          style={
            portrait
              ? {
                  height: design.window.height * 0.4,
                  // The rail floats over the content: the panel starts right of it.
                  marginLeft: s(SHELL.rail.width + DETAIL.panelInset),
                  marginRight: s(DETAIL.panelInset),
                  marginBottom: s(DETAIL.panelInset),
                }
              : {
                  width: s(DETAIL.panelWidth),
                  marginVertical: s(DETAIL.panelInset),
                  marginRight: s(DETAIL.panelInset),
                }
          }>
          {panel}
        </View>
      </View>
    </View>
  );
}
