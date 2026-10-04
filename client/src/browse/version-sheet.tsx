import { Film, X } from '@/components/icons';
import { useRouter } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import { useVersions, type Version } from '@/browse/queries';
import { sheetSpecs } from '@/browse/version-format';
import { entryIndex, VersionPanelCard } from '@/browse/version-panel';
import { FocusGuide, useFocusGlowRoom, useInitialFocus } from '@/components/focus';
import { Glass } from '@/components/glass';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { IconButton } from '@/components/ui/icon-button';
import { OverlayScrim } from '@/components/ui/overlay-scrim';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { usePlay } from '@/browse/title-actions';
import { versionsHref, type VersionsRequest } from '@/navigation/routes';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign, useFocusGap } from '@/theme';

export type VersionSheetProps = {
  workId: string | null | undefined;
  title: string;
  /** The version the viewer played last ("Last played" badge). */
  currentReleaseId?: string | null;
  onPlay: (version: Version) => void;
  onClose: () => void;
  testID?: string;
};

/** Sheet shape per device: TV glass side sheet, web/tablet drawer, iOS formSheet content. */
export type VersionSheetFrame = 'tv' | 'drawer' | 'form';

export function versionSheetFrame(): VersionSheetFrame {
  if (Platform.isTV) return 'tv';
  return Platform.OS === 'ios' ? 'form' : 'drawer';
}

/** The card the sheet focuses first: the one Play would start (Recommended, else last played, else the first). */
export function sheetEntryIndex(
  versions: readonly Pick<Version, 'recommended' | 'releaseId'>[],
  currentReleaseId?: string | null
): number {
  if (versions.some((version) => version.recommended)) return entryIndex(versions);
  const current = versions.findIndex(
    (version) => !!currentReleaseId && version.releaseId === currentReleaseId
  );
  return Math.max(0, current);
}

/** Header (title, subtitle, both specs) and the ranked version cards in every state. */
export function useVersionSheetParts({
  workId,
  title,
  currentReleaseId,
  onPlay,
  onClose,
  frame,
}: VersionSheetProps & { frame: VersionSheetFrame }) {
  const { t } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  const cardGap = useFocusGap(s(18), 'ring');
  const versions = useVersions(workId, !!workId);
  const list = versions.data?.versions ?? [];
  const error = versions.error && !versions.data ? toAppError(versions.error) : undefined;
  const entry = sheetEntryIndex(list, currentReleaseId);
  const specs = sheetSpecs(list);
  const form = frame === 'form';
  const subtitleKey =
    Platform.OS === 'web'
      ? 'versions.expected.browser'
      : Platform.OS === 'ios' && !Platform.isTV && design.formFactor !== 'phone'
        ? 'versions.expected.tablet'
        : 'versions.expected.device';

  let body: ReactNode;
  if (error)
    body = (
      <ErrorState
        testID="versions-error"
        code={error.code}
        actions={['retry']}
        autoFocus
        onAction={() => void versions.refetch()}
      />
    );
  else if (!versions.data)
    body = [0, 1, 2].map((index) => (
      <View key={index} testID="versions-loading">
        <Skeleton height={s(180)} radius={s(28)} />
      </View>
    ));
  else if (!list.length)
    body = (
      <EmptyState
        testID="versions-empty"
        icon={Film}
        title={t('versions.emptyTitle')}
        message={t('versions.emptyMessage')}
      />
    );
  else
    body = list.map((version, index) => (
      <SheetCard
        key={version.releaseId ?? index}
        version={version}
        preferred={index === entry}
        current={!!currentReleaseId && version.releaseId === currentReleaseId}
        onPress={() => onPlay(version)}
      />
    ));

  const header = (
    <View style={{ gap: s(6) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(16) }}>
        <Text
          role="heading"
          style={{
            flex: 1,
            fontFamily: fonts.displayBold,
            fontSize: form ? design.px(28) : s(44),
            lineHeight: form ? design.px(34) : s(52),
            color: colors.foreground.DEFAULT,
          }}>
          {t('versions.title')}
        </Text>
        {frame === 'tv' || (form && design.formFactor === 'phone') ? null : (
          <IconButton
            testID="version-sheet-close"
            icon={X}
            variant="ghost"
            size="sm"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
          />
        )}
      </View>
      <Text tone="muted" numberOfLines={2} style={{ fontSize: s(20), lineHeight: s(28) }}>
        {versions.data
          ? versions.data.incomplete
            ? t('versions.incomplete', { title })
            : t(subtitleKey, { title })
          : title}
      </Text>
      {specs ? <VersionSpecs specs={specs} size={s} /> : null}
    </View>
  );

  return { header, cards: <View style={{ gap: cardGap }}>{body}</View> };
}

/** "Best picture · On this device" above the version cards (every size, Q1-45). */
export function VersionSpecs({
  specs,
  size,
}: {
  specs: { best: string; here: string };
  /** Design scale of the surrounding sheet. */
  size: (value: number) => number;
}) {
  const { t } = useTranslation();
  return (
    <View
      testID="version-sheet-specs"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: size(40),
        rowGap: size(6),
        marginTop: size(14),
        paddingHorizontal: size(20),
        paddingVertical: size(14),
        borderRadius: size(16),
        borderCurve: 'continuous',
        backgroundColor: colors.glass.subtle,
      }}>
      <SpecPair label={t('versions.bestPicture')} value={specs.best} size={size} />
      <SpecPair label={t('versions.onDevice')} value={specs.here} size={size} />
    </View>
  );
}

function SpecPair({
  label,
  value,
  size,
}: {
  label: string;
  value: string;
  size: (value: number) => number;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: size(12) }}>
      <Text tone="muted" style={{ fontSize: size(18), lineHeight: size(26) }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: size(20),
          lineHeight: size(28),
          color: colors.foreground.DEFAULT,
        }}>
        {value}
      </Text>
    </View>
  );
}

function SheetCard({
  version,
  preferred,
  current,
  onPress,
}: {
  version: Version;
  preferred: boolean;
  current: boolean;
  onPress: () => void;
}) {
  const ref = useRef<View>(null);
  useInitialFocus(ref, preferred);
  return (
    <View testID={preferred ? 'version-sheet-entry' : undefined}>
      <VersionPanelCard
        ref={ref}
        version={version}
        current={current}
        preferred={preferred}
        onPress={onPress}
      />
    </View>
  );
}

/** TV and web/tablet: the glass panel at the right edge over the dimmed page. */
export function VersionSheetPanel(props: VersionSheetProps & { frame: 'tv' | 'drawer' }) {
  const { header, cards } = useVersionSheetParts(props);
  return (
    <SheetPanel
      frame={props.frame}
      testID={props.testID ?? 'version-sheet'}
      title={props.title}
      onClose={props.onClose}
      header={header}>
      {cards}
    </SheetPanel>
  );
}

/** The right-edge glass sheet (versions, about): scrim, header, a trapped list of fixed height on TV. */
export function SheetPanel({
  frame,
  testID,
  title,
  onClose,
  header,
  children,
}: {
  frame: 'tv' | 'drawer';
  testID: string;
  title: string;
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const { s } = useShell();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const glowRoom = useFocusGlowRoom();
  const [room, setRoom] = useState<number>();
  const tv = frame === 'tv';
  const inset = tv ? s(24) : 0;
  const pad = s(36);
  const width = Math.min(s(tv ? 780 : 740), design.window.width - 2 * inset);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn} exiting={FadeOut} style={StyleSheet.absoluteFill}>
        <OverlayScrim onPress={onClose} />
      </Animated.View>
      <Animated.View
        testID={testID}
        role="dialog"
        aria-modal
        aria-label={title}
        entering={SlideInRight}
        exiting={SlideOutRight}
        style={{
          position: 'absolute',
          top: tv && Platform.OS === 'ios' ? s(SHELL.tvosTabBarBottom) : inset,
          bottom: inset,
          right: inset,
          width,
          paddingTop: tv ? s(48) : Math.max(insets.top + s(16), s(40)),
          borderTopLeftRadius: s(44),
          borderBottomLeftRadius: s(44),
          borderTopRightRadius: tv ? s(44) : 0,
          borderBottomRightRadius: tv ? s(44) : 0,
          borderCurve: 'continuous',
          overflow: 'hidden',
        }}>
        <Glass intensity="regular" radius={s(44)} style={StyleSheet.absoluteFill}>
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: colors.glass.tinted, opacity: tv ? 0.85 : 0.9 },
            ]}
          />
        </Glass>
        <View style={{ paddingHorizontal: pad }}>{header}</View>
        <View style={{ flex: 1 }} onLayout={(event) => setRoom(event.nativeEvent.layout.height)}>
          {/* TV: an explicit list height (tvOS loses focus in guides laid out at 1 pt); focus stays inside. */}
          <FocusGuide
            remember={false}
            trap={['up', 'down', 'left', 'right']}
            style={room !== undefined ? { height: room } : { flex: 1 }}>
            <ScrollView
              testID={`${testID}-list`}
              showsVerticalScrollIndicator={!tv}
              style={{ flex: 1 }}
              contentContainerStyle={{
                paddingHorizontal: Math.max(pad, glowRoom),
                paddingVertical: Math.max(s(24), glowRoom),
                paddingBottom: Math.max(s(24), glowRoom) + insets.bottom,
              }}>
              {children}
            </ScrollView>
          </FocusGuide>
        </View>
      </Animated.View>
    </View>
  );
}

/** Web detail pages: the drawer as an in-page overlay (no route, so no browser history entry). */
function VersionDrawer({ open, ...props }: VersionSheetProps & { open: boolean }) {
  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={props.onClose}>
      {open ? <VersionSheetPanel {...props} frame="drawer" /> : null}
    </Modal>
  );
}

/** Web shows the sheet in the page: a route push would add a browser history entry. */
export const versionSheetHost = { inPage: () => Platform.OS === 'web' };

/** Large detail pages: "Versions · N" opens the sheet (web: in-page drawer, elsewhere the route). */
export function useVersionSheet() {
  const router = useRouter();
  const play = usePlay();
  const [request, setRequest] = useState<VersionsRequest | null>(null);
  const inPage = versionSheetHost.inPage();
  const open = (next: VersionsRequest) =>
    inPage ? setRequest(next) : router.push(versionsHref(next));
  const close = () => setRequest(null);
  const drawer = inPage ? (
    <VersionDrawer
      open={!!request}
      workId={request?.workId}
      title={request?.title ?? ''}
      currentReleaseId={request?.currentReleaseId}
      onClose={close}
      onPlay={(version) => {
        close();
        if (request) play({ ...request, releaseId: version.releaseId });
      }}
    />
  ) : null;
  return { open, drawer };
}
