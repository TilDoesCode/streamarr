import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FocusGuide, ItemSnapContext, useFocusGlowRoom } from '@/components/focus';
import { Glass } from '@/components/glass';
import { OverlayScrim } from '@/components/ui/overlay-scrim';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign } from '@/theme';
import { TVFocusHost } from '@modules/tv-native';

import { useDownloadFlow, type DownloadFlowParts, type DownloadRequest } from './download-flow';

/** Sheet shape per device: TV glass side panel, tablet drawer, Android phone bottom sheet, iOS formSheet content. */
export type DownloadFrame = 'tv' | 'drawer' | 'bottom' | 'form';

export function downloadFrame(phone: boolean): DownloadFrame {
  if (Platform.isTV) return 'tv';
  if (Platform.OS === 'ios') return 'form';
  return phone ? 'bottom' : 'drawer';
}

/** `download/[workId]`: the download flow over the page it was opened from (focus returns to its button on close). */
export function DownloadSheetScreen() {
  const router = useRouter();
  const design = useDesign();
  const params = useLocalSearchParams<{ workId: string; title?: string; series?: string }>();
  const request: DownloadRequest = {
    workId: params.workId,
    title: params.title ?? '',
    seriesTitle: params.series ?? null,
  };
  const close = () => router.back();
  const parts = useDownloadFlow({
    request,
    onClose: close,
    onOpenDownloads: () => {
      router.back();
      router.navigate('/downloads');
    },
  });
  const frame = downloadFrame(design.formFactor === 'phone');
  if (frame === 'form') return <FormFrame parts={parts} />;
  return <PanelFrame parts={parts} frame={frame} onClose={close} />;
}

/** iOS: native formSheet content (iOS 26 draws the sheet in Liquid Glass); the confirm button stays at the bottom. */
function FormFrame({ parts }: { parts: DownloadFlowParts }) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  return (
    <View testID="download-sheet" style={{ flex: 1 }}>
      <ScrollView
        key={parts.stepKey}
        testID="download-sheet-list"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: design.layout.gutter,
          gap: design.space.lg,
        }}>
        {parts.header}
        {parts.body}
      </ScrollView>
      {parts.footer ? (
        <View
          style={{
            paddingHorizontal: design.layout.gutter,
            paddingTop: design.space.md,
            paddingBottom: insets.bottom + design.space.md,
          }}>
          {parts.footer}
        </View>
      ) : null}
    </View>
  );
}

/** Android: the glass panel at the right edge (TV, tablet) or the bottom (phone) over the dimmed page. */
function PanelFrame({
  parts,
  frame,
  onClose,
}: {
  parts: DownloadFlowParts;
  frame: 'tv' | 'drawer' | 'bottom';
  onClose: () => void;
}) {
  const { s } = useShell();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const glowRoom = useFocusGlowRoom();
  const [room, setRoom] = useState<number>();
  const tv = frame === 'tv';
  const bottom = frame === 'bottom';
  const inset = tv ? s(24) : 0;
  const pad = bottom ? design.layout.gutter : s(36);
  const radius = bottom ? design.radius.xl : s(44);
  const width = bottom ? design.window.width : Math.min(s(tv ? 820 : 760), design.window.width);
  const placement = bottom
    ? {
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: design.window.height * 0.9,
        paddingTop: design.space.sm,
        borderTopLeftRadius: radius,
        borderTopRightRadius: radius,
      }
    : {
        top: tv && Platform.OS === 'ios' ? s(SHELL.tvosTabBarBottom) : inset,
        bottom: inset,
        right: inset,
        width,
        paddingTop: tv ? s(48) : Math.max(insets.top + s(16), s(40)),
        borderTopLeftRadius: radius,
        borderBottomLeftRadius: radius,
        borderTopRightRadius: tv ? radius : 0,
        borderBottomRightRadius: tv ? radius : 0,
      };
  return (
    <TVFocusHost style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn} exiting={FadeOut} style={StyleSheet.absoluteFill}>
        <OverlayScrim onPress={onClose} />
      </Animated.View>
      <Animated.View
        testID="download-sheet"
        role="dialog"
        aria-modal
        entering={bottom ? SlideInDown : SlideInRight}
        style={[
          { position: 'absolute', borderCurve: 'continuous', overflow: 'hidden' },
          placement,
        ]}>
        <Glass
          intensity={bottom ? 'strong' : 'regular'}
          radius={radius}
          style={StyleSheet.absoluteFill}>
          <View
            style={[
              StyleSheet.absoluteFill,
              bottom
                ? { backgroundColor: colors.surface.raised }
                : { backgroundColor: colors.glass.tinted, opacity: tv ? 0.85 : 0.9 },
            ]}
          />
        </Glass>
        {bottom ? <Grabber /> : null}
        {/* TV: focus stays inside the panel; Back steps back in the flow, then closes it. */}
        <FocusGuide
          remember={false}
          trap={['up', 'down', 'left', 'right']}
          style={bottom ? { flexShrink: 1 } : { flex: 1 }}>
          <View style={{ paddingHorizontal: pad, paddingBottom: design.space.md }}>
            {parts.header}
          </View>
          <View
            style={bottom ? { flexShrink: 1 } : { flex: 1 }}
            onLayout={tv ? (event) => setRoom(event.nativeEvent.layout.height) : undefined}>
            <ItemSnapContext value={tv ? 'center' : undefined}>
              <ScrollView
                key={parts.stepKey}
                testID="download-sheet-list"
                showsVerticalScrollIndicator={!tv}
                // TV: an explicit height (a focus guide around a flex child can collapse it).
                style={tv && room !== undefined ? { height: room } : { flexGrow: 0 }}
                contentContainerStyle={{
                  paddingHorizontal: Math.max(pad, glowRoom),
                  paddingVertical: Math.max(s(12), glowRoom),
                }}>
                {parts.body}
              </ScrollView>
            </ItemSnapContext>
          </View>
          {parts.footer ? (
            <Footer pad={pad} bottomInset={tv ? s(36) : insets.bottom + design.space.md}>
              {parts.footer}
            </Footer>
          ) : null}
        </FocusGuide>
      </Animated.View>
    </TVFocusHost>
  );
}

function Footer({
  pad,
  bottomInset,
  children,
}: {
  pad: number;
  bottomInset: number;
  children: ReactNode;
}) {
  const design = useDesign();
  return (
    <View
      style={{
        paddingHorizontal: pad,
        paddingTop: design.space.md,
        paddingBottom: bottomInset,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.glass.border,
      }}>
      {children}
    </View>
  );
}

function Grabber() {
  return (
    <View
      style={{
        alignSelf: 'center',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginBottom: 8,
        backgroundColor: colors.foreground.subtle,
      }}
    />
  );
}
