'use no memo';
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Cpu,
  Expand,
  Gauge,
  Info,
  Layers,
  Maximize,
  PictureInPicture2,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Shrink,
  Volume2,
  VolumeX,
  type LucideIcon,
  Ellipsis,
} from 'lucide-react-native';
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { VideoAirPlayButton } from 'expo-video';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { languageName } from '@/browse/version-format';
import { Glass, GlassButton, GlassGroup } from '@/components/glass';
import { Scrim } from '@/components/media/scrim';
import { CENTRED_ROW, FocusGuide, Focusable, FocusLift, tvFocus } from '@/components/focus';
import { Text } from '@/components/ui/text';
import type { PlaybackController } from '@/player/controller';
import { clock as formatClock, scrubStep } from '@/player/format';
import {
  fullscreenAvailable,
  fullscreenChromeInset,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from '@/player/fullscreen';
import { useRemoteKeys } from '@/player/remote-keys';
import { useFadedOut } from '@/player/use-faded-out';
import { useTVEvents } from '@/player/use-tv-events';
import type { Clock } from '@/player/use-clock';
import { useWindowControlsInset } from '@/shell/window-controls';
import {
  audioLayout,
  barChipsLabelled,
  LARGE_TITLE_MAX_WIDTH,
  qualityLabel,
} from '@/player/overlay-labels';
import { usePlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { effectiveMuted, TEST_MUTED } from '@/player/test-muted';
import { colors, fonts, useDesign, useFocusGap } from '@/theme';

import { PANELS, type PanelKind } from './player-panels';

const HIDE_MS = 5000;
const COMMIT_MS = 700;
// UIKit drops focus from views below alpha 0.01 or without interaction; the AVPlayer view would then eat the remote.
const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;
const HIDDEN_ALPHA = APPLE_TV ? 0.011 : 0;
const FADE_OUT_MS = 400;
// react-native-web has no TV event hook.
const DOUBLE_TAP_SECONDS = 10;
const DOUBLE_TAP_WINDOW_MS = 300;

const PANEL_ICONS: Record<PanelKind, LucideIcon> = {
  audio: AudioLines,
  subtitles: Captions,
  version: Layers,
  quality: Gauge,
  engine: Cpu,
  info: Info,
};

type Zone = 'buttons' | 'progress';

export type PlayerOverlayProps = {
  controller: PlaybackController;
  clock: Clock;
  title: string;
  /** A panel or the up-next card owns the keys and focus. */
  suspended: boolean;
  /** The end card covers the video: controls hide, the picture stays. */
  ended?: boolean;
  onPanel: (panel: PanelKind) => void;
  /** The open side panel (its chip shows as selected). */
  panel?: PanelKind | null;
  onClose: () => void;
  /** Registers the overlay's Back step: true when it hid the overlay. */
  backRef: RefObject<(() => boolean) | null>;
  /** The overlay showed or hid (the player slows its clock while nothing shows it). */
  onVisibleChange?: (visible: boolean) => void;
};

/** Our own controls over every engine: title, progress with buffered range, transport, panels, keys and gestures. */
export function PlayerOverlay({
  controller,
  clock,
  title,
  suspended,
  ended = false,
  onPanel,
  panel: openPanel = null,
  onClose,
  backRef,
  onVisibleChange,
}: PlayerOverlayProps) {
  const pt = usePlayerT();
  const design = useDesign();
  const { large, s, font } = useShell();
  const barGap = useFocusGap(large ? s(14) : design.space.sm);
  // Narrow phones: the row drops its Play (the centre cluster has it) and uses smaller chips.
  const narrow = design.window.width < 420;
  const chip = narrow ? 40 : 44;
  const [moreOpen, setMoreOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const windowInset = useWindowControlsInset();
  const window = useWindowDimensions();
  const [visible, setVisible] = useState(true);
  const [zone, setZone] = useState<Zone>('buttons');
  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(TEST_MUTED);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  const chromeInset = fullscreenChromeInset(fullscreen);
  const windowControls = windowInset + chromeInset;
  const [flash, setFlash] = useState<string | null>(null);
  const scrubRef = useRef<number | null>(null);
  const handOver = useRef(false);
  const rowFocused = useRef(false);
  const onRowFocus = () => {
    rowFocused.current = true;
    setZone('buttons');
  };
  const onRowBlur = () => {
    rowFocused.current = false;
  };
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playRef = useRef<View>(null);
  const seekRef = useRef<View>(null);
  const paused = controller.paused;
  const duration = clock.duration || controller.duration;
  // Live engine position: the clock steps coarsely while the overlay is hidden, so its first visible frame may lag.
  const position = scrub ?? controller.position;
  const tv = design.isTV;
  const Surface = controller.engine?.Surface;

  const hideLater = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    if (paused || suspended || scrubRef.current !== null) return;
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_MS);
  };
  const onVisibility = useEffectEvent(hideLater);

  const show = (next: Zone = zone) => {
    setVisible(true);
    setZone(next);
    hideLater();
  };

  // Restart the hide timer once the picture runs, so the overlay is seen after a slow start.
  const running = controller.engine?.getSnapshot().state === 'playing';
  useEffect(() => {
    if (visible) onVisibility();
  }, [visible, paused, suspended, running]);

  useEffect(
    () => () => {
      for (const timer of [hideTimer, commitTimer, flashTimer])
        if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  useEffect(() => onFullscreenChange(() => setFullscreen(isFullscreen())), []);

  useEffect(() => onVisibleChange?.(visible), [visible, onVisibleChange]);

  // TV: focus follows the zone so focus is never lost while the overlay shows.
  useEffect(() => {
    if (!tv || !visible || suspended) return;
    // Native focus already on the row (kept while hidden) must not be pulled back: a quick ▶ would be lost.
    if (zone === 'progress') tvFocus(seekRef.current);
    else if (!rowFocused.current) tvFocus(playRef.current);
  }, [tv, visible, zone, suspended, Surface]);

  // tvOS cannot hold the arrows while hidden: park focus where ◀/▶ have no native neighbour.
  useEffect(() => {
    if (APPLE_TV && !visible && !suspended) tvFocus(seekRef.current);
  }, [visible, suspended]);

  // Keys keep the overlay up; ▼ on the button row moves to the seek bar (nothing focusable below).
  useTVEvents((event) => {
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (!tv || !visible || suspended || keyAction === 0) return;
    if (event.eventType === 'down' && zone === 'buttons') show('progress');
    else hideLater();
  });

  useEffect(() => {
    backRef.current = () => {
      if (!visible) return false;
      setVisible(false);
      setScrub(null);
      scrubRef.current = null;
      return true;
    };
  });

  const showFlash = (text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 700);
  };

  const commitScrub = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    const target = scrubRef.current;
    scrubRef.current = null;
    setScrub(null);
    if (target !== null) controller.seekTo(target);
    hideLater();
  };

  const scrubTo = (target: number, commitAfter = COMMIT_MS) => {
    const clamped = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    scrubRef.current = clamped;
    setScrub(clamped);
    setVisible(true);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitScrub, commitAfter);
  };

  const scrubBy = (direction: -1 | 1, repeat: number) => {
    // The live position: the clock is coarse while the overlay is hidden.
    const base = scrubRef.current ?? controller.position;
    scrubTo(base + scrubStep(direction, repeat));
    if (!visible) setZone('progress');
  };

  const toggleMute = () => {
    const next = !muted;
    controller.engine?.setMuted?.(next);
    setMuted(effectiveMuted(next));
  };

  // Keyboards (web, iPad) have no focus row to hand the arrows to.
  const keyboard = Platform.OS === 'web' || (Platform.OS === 'ios' && !tv);
  const captureDpad = !suspended && (keyboard || !visible || zone === 'progress');
  useEffect(() => {
    if (captureDpad) handOver.current = false;
  }, [captureDpad]);

  useRemoteKeys(captureDpad, (action, _key, repeat) => {
    switch (action) {
      case 'toggle':
        if (scrubRef.current !== null) commitScrub();
        else controller.togglePlay();
        show();
        return;
      case 'play':
      case 'pause':
        controller.setPaused(action === 'pause');
        show();
        return;
      case 'back10':
      case 'forward30':
        // A ◀/▶ that raced the hand-over to the button row must not seek.
        if (handOver.current) return;
        scrubBy(action === 'back10' ? -1 : 1, repeat);
        return;
      case 'rewind':
      case 'fastForward':
        scrubBy(action === 'rewind' ? -1 : 1, repeat);
        return;
      case 'up':
        handOver.current = tv;
        if (tv && !rowFocused.current) tvFocus(playRef.current);
        show('buttons');
        return 'release';
      case 'down':
        if (visible && zone === 'progress') show('buttons');
        else show('progress');
        return;
      case 'stop':
        onClose();
        return;
      case 'fullscreen':
        toggleFullscreen();
        return;
      case 'mute':
        toggleMute();
        return;
    }
  });

  const fade = useAnimatedStyle(
    () => ({
      opacity: withTiming(visible ? 1 : HIDDEN_ALPHA, { duration: visible ? 150 : FADE_OUT_MS }),
    }),
    [visible]
  );
  // iOS Liquid Glass may outlive an ancestor's fade: native touch shells drop the controls after it (TV/web keep focus).
  const gone = useFadedOut(visible, FADE_OUT_MS + 50, !tv && Platform.OS !== 'web');

  /* eslint-disable react-hooks/refs -- gesture callbacks run on touch, not during render */
  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(250)
    .onEnd((event) => {
      // Web: a click follows a mouse move that already showed the overlay, so it toggles playback.
      if (Platform.OS === 'web') {
        controller.togglePlay();
        show();
        return;
      }
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
        tapTimer.current = null;
        const forward = event.x > window.width / 2;
        controller.seekBy(forward ? DOUBLE_TAP_SECONDS : -DOUBLE_TAP_SECONDS);
        showFlash(forward ? `+${DOUBLE_TAP_SECONDS}` : `−${DOUBLE_TAP_SECONDS}`);
        return;
      }
      const wasVisible = visible;
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        if (wasVisible) setVisible(false);
        else show();
      }, DOUBLE_TAP_WINDOW_MS);
    });
  const doubleClick = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .enabled(Platform.OS === 'web')
    .onEnd(() => toggleFullscreen());
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onEnd((event) => {
      if (event.scale > 1.1) setFit('cover');
      else if (event.scale < 0.9) setFit('contain');
    });
  const surfaceGestures =
    Platform.OS === 'web' ? Gesture.Exclusive(doubleClick, tap) : Gesture.Simultaneous(pinch, tap);
  /* eslint-enable react-hooks/refs */

  const bottom = Math.max(insets.bottom, design.layout.edgeVertical);
  const top = Math.max(insets.top, design.layout.edgeVertical) + chromeInset;
  const remaining = Math.max(0, duration - position);
  const panelButtons = PANELS.filter(
    (panel) =>
      (panel !== 'audio' || (controller.playback?.mediaInfo?.audioTracks?.length ?? 0) > 0) &&
      (panel !== 'subtitles' || (controller.playback?.mediaInfo?.subtitleTracks?.length ?? 0) > 0)
  );

  const info = controller.playback?.mediaInfo;
  const audioTrack = info?.audioTracks?.find((track) => track.index === controller.currentAudio());
  const subtitleTrack = info?.subtitleTracks?.find(
    (track) => track.index === controller.currentSubtitle()
  );
  const engineVideo = controller.engine?.getSnapshot().tracks.video;
  const chipLabel: Record<PanelKind, string> = {
    audio: audioTrack
      ? [
          audioTrack.language ? languageName(audioTrack.language, i18n.language, t) : '',
          // What the viewer hears, like the audio panel; Info shows a conversion (5.1 → 2.0).
          audioLayout(audioTrack, controller.renditionOf(audioTrack.index)),
        ]
          .filter(Boolean)
          .join(' ') || pt('controls.audio')
      : pt('controls.audio'),
    subtitles: subtitleTrack?.language
      ? languageName(subtitleTrack.language, i18n.language, t)
      : subtitleTrack
        ? pt('controls.subtitles')
        : pt('subtitlesOff'),
    version:
      qualityLabel(
        engineVideo?.height ?? info?.video?.deliveredHeight ?? info?.video?.height,
        info?.video?.videoRange || info?.video?.hdr
      ) || pt('controls.version'),
    quality: pt('controls.quality'),
    engine: pt('controls.engine'),
    info: pt('controls.info'),
  };
  const timeText = {
    fontSize: font(22, 14),
    lineHeight: font(30, 19),
    color: colors.foreground.DEFAULT,
  };
  // Narrow windows: the panel chips fold into one "More" button so the row never overflows.
  const collapse = narrow && !tv && panelButtons.length > 2;
  const chipText = barChipsLabelled(window.width, tv);
  const labelled = (panel: PanelKind) =>
    chipText &&
    (panel === 'audio' || panel === 'subtitles' || panel === 'version' || panel === 'info');

  return (
    <View
      style={StyleSheet.absoluteFill}
      onPointerMove={Platform.OS === 'web' ? () => show() : undefined}>
      {Surface ? <Surface style={StyleSheet.absoluteFill} fit={fit} /> : null}
      {controller.pictureInPicture || ended ? null : (
        <>
          {tv ? null : (
            <GestureDetector gesture={surfaceGestures}>
              <View testID="player-surface" style={StyleSheet.absoluteFill} />
            </GestureDetector>
          )}
          {flash ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.centre]}>
              <Text variant="title">{flash}</Text>
            </View>
          ) : null}
          <Animated.View
            testID={visible ? 'player-overlay' : 'player-overlay-hidden'}
            pointerEvents={visible || APPLE_TV ? 'box-none' : 'none'}
            style={[StyleSheet.absoluteFill, fade, gone && styles.gone]}>
            <Scrim
              direction="down"
              color={colors.scrim.DEFAULT}
              style={[styles.topShade, { height: top + design.px(tv ? 220 : 140) }]}
            />
            <Scrim
              direction="up"
              color={colors.scrim.DEFAULT}
              style={[styles.bottomShade, { height: bottom + design.px(tv ? 340 : 210) }]}
            />
            {large ? (
              <View
                pointerEvents="box-none"
                style={{
                  position: 'absolute',
                  top: Math.max(insets.top, s(64)) + windowControls,
                  left: s(96),
                  right: s(96),
                  gap: s(14),
                  alignItems: 'flex-start',
                }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: barGap }}>
                  {tv ? null : (
                    <GlassButton
                      testID="player-close"
                      iconOnly
                      icon={ArrowLeft}
                      label={pt('controls.close')}
                      onPress={onClose}
                    />
                  )}
                  <Glass
                    testID="player-now-playing"
                    intensity="subtle"
                    radius={s(20)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: s(10),
                      height: s(40),
                      paddingHorizontal: s(18),
                    }}>
                    <View
                      style={{
                        width: s(10),
                        height: s(10),
                        borderRadius: s(5),
                        backgroundColor: colors.success.DEFAULT,
                      }}
                    />
                    <Text style={{ fontSize: font(18, 13), lineHeight: font(24, 17) }}>
                      {pt('controls.nowPlaying')}
                    </Text>
                  </Glass>
                  {controller.phase === 'switching' ? (
                    <Text variant="caption" tone="muted">
                      {pt('stepper.switching')}
                    </Text>
                  ) : null}
                </View>
                <Text
                  testID="player-title"
                  numberOfLines={1}
                  style={{
                    maxWidth: LARGE_TITLE_MAX_WIDTH,
                    fontFamily: fonts.displayBold,
                    fontSize: s(56),
                    lineHeight: s(68),
                    letterSpacing: -s(1),
                    color: colors.foreground.DEFAULT,
                  }}>
                  {title}
                </Text>
              </View>
            ) : (
              <View
                pointerEvents="box-none"
                style={{
                  position: 'absolute',
                  top,
                  left: design.layout.gutter,
                  right: design.layout.gutter,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: design.space.md,
                }}>
                {tv ? null : (
                  <GlassButton
                    testID="player-close"
                    iconOnly
                    size={44}
                    icon={ArrowLeft}
                    label={pt('controls.close')}
                    onPress={onClose}
                  />
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <View
                    style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                    <View
                      testID="player-now-playing"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: colors.success.DEFAULT,
                      }}
                    />
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {controller.phase === 'switching'
                        ? pt('stepper.switching')
                        : pt('controls.nowPlaying')}
                    </Text>
                  </View>
                  <Text
                    testID="player-title"
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.displayBold,
                      fontSize: tv ? 28 : 20,
                      lineHeight: tv ? 34 : 26,
                      color: colors.foreground.DEFAULT,
                    }}>
                    {title}
                  </Text>
                </View>
              </View>
            )}
            {tv || large ? null : (
              <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.centre]}>
                <GlassGroup
                  spacing={design.space.xl}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.xl }}>
                  <GlassButton
                    testID="player-back10"
                    iconOnly
                    size={56}
                    icon={RotateCcw}
                    label={pt('controls.back10')}
                    onPress={() => controller.seekBy(-10)}
                  />
                  <GlassButton
                    testID="player-toggle-centre"
                    tone="solid"
                    iconOnly
                    size={72}
                    icon={paused ? Play : Pause}
                    label={pt(paused ? 'controls.play' : 'controls.pause')}
                    onPress={() => controller.togglePlay()}
                  />
                  <GlassButton
                    testID="player-forward30"
                    iconOnly
                    size={56}
                    icon={RotateCw}
                    label={pt('controls.forward30')}
                    onPress={() => controller.seekBy(30)}
                  />
                </GlassGroup>
              </View>
            )}
            {large ? (
              <Glass
                testID="player-bar"
                intensity="regular"
                radius={s(40)}
                style={{
                  position: 'absolute',
                  left: s(64),
                  right: s(64),
                  bottom: Math.max(insets.bottom, s(40)),
                  paddingHorizontal: s(36),
                  paddingTop: s(20),
                  paddingBottom: s(24),
                  gap: s(6),
                }}>
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    { borderRadius: s(40), backgroundColor: colors.glass.tinted, opacity: 0.55 },
                  ]}
                />
                <SeekBar
                  seekRef={seekRef}
                  position={position}
                  buffered={clock.buffered}
                  duration={duration}
                  scrubbing={scrub !== null}
                  light
                  label={pt('controls.seek')}
                  onFocus={() => {
                    rowFocused.current = false;
                    setZone('progress');
                  }}
                  onScrub={(target) => scrubTo(target, 60_000)}
                  onScrubEnd={commitScrub}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text testID="player-position" style={timeText}>
                    {formatClock(position)}
                  </Text>
                  <Text testID="player-remaining" style={timeText}>
                    {`−${formatClock(remaining)}`}
                  </Text>
                </View>
                <FocusGuide
                  remember
                  trap={CENTRED_ROW}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: barGap,
                    marginTop: s(8),
                  }}>
                  <GlassButton
                    ref={playRef}
                    testID="player-toggle"
                    tone="solid"
                    iconOnly
                    icon={paused ? Play : Pause}
                    label={pt(paused ? 'controls.play' : 'controls.pause')}
                    onFocus={onRowFocus}
                    onBlur={onRowBlur}
                    onPress={() => {
                      controller.togglePlay();
                      show('buttons');
                    }}
                  />
                  <GlassButton
                    testID={tv ? 'player-back10-tv' : 'player-back10'}
                    tone="plain"
                    iconOnly
                    icon={RotateCcw}
                    label={pt('controls.back10')}
                    onFocus={onRowFocus}
                    onBlur={onRowBlur}
                    onPress={() => {
                      controller.seekBy(-10);
                      show('buttons');
                    }}
                  />
                  <GlassButton
                    testID={tv ? 'player-forward30-tv' : 'player-forward30'}
                    tone="plain"
                    iconOnly
                    icon={RotateCw}
                    label={pt('controls.forward30')}
                    onFocus={onRowFocus}
                    onBlur={onRowBlur}
                    onPress={() => {
                      controller.seekBy(30);
                      show('buttons');
                    }}
                  />
                  <View style={{ flex: 1 }} />
                  {panelButtons.map((panel) => (
                    <GlassButton
                      key={panel}
                      testID={`player-open-${panel}`}
                      icon={PANEL_ICONS[panel]}
                      iconOnly={!labelled(panel)}
                      tone={openPanel === panel ? 'solid' : 'plain'}
                      label={labelled(panel) ? chipLabel[panel] : pt(`controls.${panel}`)}
                      accessibilityLabel={
                        panel !== 'info' && panel !== 'quality' && panel !== 'engine'
                          ? `${pt(`controls.${panel}`)}: ${chipLabel[panel]}`
                          : pt(`controls.${panel}`)
                      }
                      onFocus={onRowFocus}
                      onBlur={onRowBlur}
                      onPress={() => onPanel(panel)}
                    />
                  ))}
                  {Platform.OS === 'web' ? (
                    <GlassButton
                      testID="player-mute"
                      tone="plain"
                      iconOnly
                      icon={muted ? VolumeX : Volume2}
                      label={pt(muted ? 'controls.unmute' : 'controls.mute')}
                      onPress={toggleMute}
                    />
                  ) : null}
                  {fullscreenAvailable ? (
                    <GlassButton
                      testID="player-fullscreen"
                      tone="plain"
                      iconOnly
                      icon={fullscreen ? Minimize : Maximize}
                      label={pt(fullscreen ? 'controls.exitFullscreen' : 'controls.fullscreen')}
                      onPress={toggleFullscreen}
                    />
                  ) : null}
                  {controller.engine?.supportsPictureInPicture ? (
                    <GlassButton
                      testID="player-pip"
                      iconOnly
                      icon={PictureInPicture2}
                      label={pt('controls.pip')}
                      onPress={() => controller.engine?.startPictureInPicture?.()}
                    />
                  ) : null}
                  {controller.engine?.supportsAirPlay ? <AirPlayButton size={44} /> : null}
                </FocusGuide>
              </Glass>
            ) : (
              <View
                pointerEvents="box-none"
                style={{
                  position: 'absolute',
                  left: design.layout.gutter,
                  right: design.layout.gutter,
                  bottom,
                  gap: design.space.sm,
                }}>
                <SeekBar
                  seekRef={seekRef}
                  position={position}
                  buffered={clock.buffered}
                  duration={duration}
                  scrubbing={scrub !== null}
                  light
                  label={pt('controls.seek')}
                  onFocus={() => {
                    rowFocused.current = false;
                    setZone('progress');
                  }}
                  onScrub={(target) => scrubTo(target, 60_000)}
                  onScrubEnd={commitScrub}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text testID="player-position" variant="caption" tone="muted">
                    {formatClock(position)}
                  </Text>
                  <Text testID="player-remaining" variant="caption" tone="muted">
                    {`−${formatClock(remaining)}`}
                  </Text>
                </View>
                {collapse && moreOpen ? (
                  <View
                    testID="player-more-row"
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'flex-end',
                      gap: barGap,
                    }}>
                    {panelButtons.map((panel) => (
                      <GlassButton
                        iconOnly
                        size={chip}
                        key={panel}
                        testID={`player-open-${panel}`}
                        icon={PANEL_ICONS[panel]}
                        label={pt(`controls.${panel}`)}
                        onPress={() => {
                          setMoreOpen(false);
                          onPanel(panel);
                        }}
                      />
                    ))}
                  </View>
                ) : null}
                <FocusGuide
                  remember
                  trap={CENTRED_ROW}
                  style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <GlassGroup
                    spacing={design.space.sm}
                    style={{
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: barGap,
                    }}>
                    {tv || (Platform.OS === 'web' && !narrow) ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        ref={playRef}
                        testID="player-toggle"
                        tone="solid"
                        icon={paused ? Play : Pause}
                        label={pt(paused ? 'controls.play' : 'controls.pause')}
                        onFocus={onRowFocus}
                        onBlur={onRowBlur}
                        onPress={() => {
                          controller.togglePlay();
                          show('buttons');
                        }}
                      />
                    ) : null}
                    {tv ? (
                      <>
                        <GlassButton
                          iconOnly
                          size={chip}
                          testID="player-back10-tv"
                          icon={RotateCcw}
                          label={pt('controls.back10')}
                          onFocus={onRowFocus}
                          onBlur={onRowBlur}
                          onPress={() => {
                            controller.seekBy(-10);
                            show('buttons');
                          }}
                        />
                        <GlassButton
                          iconOnly
                          size={chip}
                          testID="player-forward30-tv"
                          icon={RotateCw}
                          label={pt('controls.forward30')}
                          onFocus={onRowFocus}
                          onBlur={onRowBlur}
                          onPress={() => {
                            controller.seekBy(30);
                            show('buttons');
                          }}
                        />
                      </>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    {collapse ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        testID="player-more"
                        icon={Ellipsis}
                        tone={moreOpen ? 'solid' : 'glass'}
                        label={pt('controls.more')}
                        onPress={() => setMoreOpen((open) => !open)}
                      />
                    ) : null}
                    {(collapse ? [] : panelButtons).map((panel) => (
                      <GlassButton
                        iconOnly
                        size={chip}
                        key={panel}
                        testID={`player-open-${panel}`}
                        icon={PANEL_ICONS[panel]}
                        label={pt(`controls.${panel}`)}
                        onFocus={onRowFocus}
                        onBlur={onRowBlur}
                        onPress={() => onPanel(panel)}
                      />
                    ))}
                    {Platform.OS === 'web' ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        testID="player-mute"
                        icon={muted ? VolumeX : Volume2}
                        label={pt(muted ? 'controls.unmute' : 'controls.mute')}
                        onPress={toggleMute}
                      />
                    ) : null}
                    {fullscreenAvailable ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        testID="player-fullscreen"
                        icon={fullscreen ? Minimize : Maximize}
                        label={pt(fullscreen ? 'controls.exitFullscreen' : 'controls.fullscreen')}
                        onPress={toggleFullscreen}
                      />
                    ) : null}
                    {controller.engine?.supportsPictureInPicture ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        testID="player-pip"
                        icon={PictureInPicture2}
                        label={pt('controls.pip')}
                        onPress={() => controller.engine?.startPictureInPicture?.()}
                      />
                    ) : null}
                    {controller.engine?.supportsAirPlay ? <AirPlayButton size={chip} /> : null}
                    {!tv && Platform.OS !== 'web' ? (
                      <GlassButton
                        iconOnly
                        size={chip}
                        testID="player-fit"
                        icon={fit === 'cover' ? Shrink : Expand}
                        label={pt(fit === 'cover' ? 'controls.fit' : 'controls.fill')}
                        onPress={() => setFit(fit === 'cover' ? 'contain' : 'cover')}
                      />
                    ) : null}
                  </GlassGroup>
                </FocusGuide>
              </View>
            )}
          </Animated.View>
        </>
      )}
    </View>
  );
}

type SeekBarProps = {
  seekRef: RefObject<View | null>;
  position: number;
  buffered: number;
  duration: number;
  scrubbing: boolean;
  /** Aurora: white progress on the glass bar. */
  light?: boolean;
  label: string;
  onFocus: () => void;
  onScrub: (target: number) => void;
  onScrubEnd: () => void;
};

/** Progress with the buffered range; focusable on TV (◀/▶ scrub), draggable on touch and mouse. */
function SeekBar({
  seekRef,
  position,
  buffered,
  duration,
  scrubbing,
  light = false,
  label,
  onFocus,
  onScrub,
  onScrubEnd,
}: SeekBarProps) {
  const design = useDesign();
  const [width, setWidth] = useState(0);
  const fraction = (value: number) => (duration ? Math.min(1, Math.max(0, value / duration)) : 0);
  const height = design.px(design.isTV ? 6 : 4);
  const thumb = design.px(design.isTV ? 18 : 14);
  const target = (x: number) => (width ? (x / width) * duration : 0);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((event) => onScrub(target(event.x)))
    .onUpdate((event) => onScrub(target(event.x)))
    .onFinalize(() => onScrubEnd());

  const bar = (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        setWidth(event.nativeEvent.layout.width);
      }}
      style={{ height: thumb * 1.6, justifyContent: 'center' }}>
      <View
        style={{
          height,
          borderRadius: height,
          backgroundColor: light ? colors.glass.subtle : colors.input,
          overflow: 'hidden',
        }}>
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fraction(buffered) * 100}%`,
            backgroundColor: colors.foreground.subtle,
          }}
        />
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fraction(position) * 100}%`,
            backgroundColor: light ? colors.foreground.DEFAULT : colors.accent.DEFAULT,
          }}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: `${fraction(position) * 100}%`,
          marginLeft: -thumb / 2,
          width: thumb,
          height: thumb,
          borderRadius: thumb,
          backgroundColor: scrubbing ? colors.accent.DEFAULT : colors.foreground.DEFAULT,
        }}
      />
    </View>
  );

  if (design.isTV)
    return (
      <Focusable
        ref={seekRef}
        testID="player-seek"
        role="slider"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position) }}
        onFocus={onFocus}>
        <FocusLift kind="none" radius={thumb * 0.8}>
          {bar}
        </FocusLift>
      </Focusable>
    );
  return (
    <GestureDetector gesture={pan}>
      <View
        testID="player-seek"
        role="slider"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position) }}>
        {bar}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', justifyContent: 'center' },
  topShade: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  gone: { display: 'none' },
});

/** AVRoutePickerView in a glass circle, sized like the other chips. */
function AirPlayButton({ size }: { size: number }) {
  const pt = usePlayerT();
  return (
    <Glass
      style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}
      testID="player-airplay"
      accessibilityLabel={pt('controls.airplay')}>
      <VideoAirPlayButton
        style={{ flex: 1 }}
        tint={colors.foreground.DEFAULT}
        activeTint={colors.accent.DEFAULT}
        prioritizeVideoDevices
      />
    </Glass>
  );
}
