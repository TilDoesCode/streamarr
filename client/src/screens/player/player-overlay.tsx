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
} from 'lucide-react-native';
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import {
  Platform,
  StyleSheet,
  useTVEventHandler,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Scrim } from '@/components/media/scrim';
import { CENTRED_ROW, FocusGuide, Focusable, FocusLift } from '@/components/focus';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import type { PlaybackController } from '@/player/controller';
import { clock as formatClock, scrubStep } from '@/player/format';
import {
  fullscreenAvailable,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from '@/player/fullscreen';
import { useRemoteKeys } from '@/player/remote-keys';
import type { Clock } from '@/player/use-clock';
import { usePlayerT } from '@/player/use-player-t';
import { colors, useDesign } from '@/theme';

import { PANELS, type PanelKind } from './player-panels';

const HIDE_MS = 5000;
const COMMIT_MS = 700;
// react-native-web has no TV event hook.
const useTVEvents: typeof useTVEventHandler = useTVEventHandler ?? (() => undefined);
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
  onPanel: (panel: PanelKind) => void;
  onClose: () => void;
  /** Registers the overlay's Back step: true when it hid the overlay. */
  backRef: RefObject<(() => boolean) | null>;
};

/** Our own controls over every engine: title, progress with buffered range, transport, panels, keys and gestures. */
export function PlayerOverlay({
  controller,
  clock,
  title,
  suspended,
  onPanel,
  onClose,
  backRef,
}: PlayerOverlayProps) {
  const pt = usePlayerT();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [visible, setVisible] = useState(true);
  const [zone, setZone] = useState<Zone>('buttons');
  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const [fullscreen, setFullscreen] = useState(isFullscreen);
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
  const position = scrub ?? clock.position;
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

  // TV: focus follows the zone so focus is never lost while the overlay shows.
  useEffect(() => {
    if (!tv || !visible || suspended) return;
    // Native focus already on the row (kept while hidden) must not be pulled back: a quick ▶ would be lost.
    if (zone === 'progress') seekRef.current?.requestTVFocus?.();
    else if (!rowFocused.current) playRef.current?.requestTVFocus?.();
  }, [tv, visible, zone, suspended, Surface]);

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
    const base = scrubRef.current ?? clock.position;
    scrubTo(base + scrubStep(direction, repeat));
    if (!visible) setZone('progress');
  };

  const toggleMute = () => {
    const next = !muted;
    controller.engine?.setMuted?.(next);
    setMuted(next);
  };

  const captureDpad = !suspended && (Platform.OS === 'web' || !visible || zone === 'progress');
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
        if (tv && !rowFocused.current) playRef.current?.requestTVFocus?.();
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
    () => ({ opacity: withTiming(visible ? 1 : 0, { duration: visible ? 150 : 400 }) }),
    [visible]
  );

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
  const top = Math.max(insets.top, design.layout.edgeVertical);
  const remaining = Math.max(0, duration - position);
  const panelButtons = PANELS.filter(
    (panel) =>
      (panel !== 'audio' || (controller.playback?.mediaInfo?.audioTracks?.length ?? 0) > 0) &&
      (panel !== 'subtitles' || (controller.playback?.mediaInfo?.subtitleTracks?.length ?? 0) > 0)
  );

  return (
    <View
      style={StyleSheet.absoluteFill}
      onPointerMove={Platform.OS === 'web' ? () => show() : undefined}>
      {Surface ? <Surface style={StyleSheet.absoluteFill} fit={fit} /> : null}
      {controller.pictureInPicture ? null : (
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
            pointerEvents={visible ? 'box-none' : 'none'}
            style={[StyleSheet.absoluteFill, fade]}>
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
                <IconButton
                  testID="player-close"
                  icon={ArrowLeft}
                  variant="ghost"
                  accessibilityLabel={pt('controls.close')}
                  onPress={onClose}
                />
              )}
              <Text
                testID="player-title"
                variant={tv ? 'heading' : 'subheading'}
                numberOfLines={1}
                style={{ flex: 1 }}>
                {title}
              </Text>
              {controller.phase === 'switching' ? (
                <Text variant="caption" tone="muted">
                  {pt('stepper.switching')}
                </Text>
              ) : null}
            </View>
            {tv ? null : (
              <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.centre]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.xl }}>
                  <View style={styles.centreBacking}>
                    <IconButton
                      testID="player-back10"
                      icon={RotateCcw}
                      variant="ghost"
                      size="lg"
                      accessibilityLabel={pt('controls.back10')}
                      onPress={() => controller.seekBy(-10)}
                    />
                  </View>
                  <View style={styles.centreBacking}>
                    <IconButton
                      testID="player-toggle-centre"
                      icon={paused ? Play : Pause}
                      size="lg"
                      accessibilityLabel={pt(paused ? 'controls.play' : 'controls.pause')}
                      onPress={() => controller.togglePlay()}
                    />
                  </View>
                  <View style={styles.centreBacking}>
                    <IconButton
                      testID="player-forward30"
                      icon={RotateCw}
                      variant="ghost"
                      size="lg"
                      accessibilityLabel={pt('controls.forward30')}
                      onPress={() => controller.seekBy(30)}
                    />
                  </View>
                </View>
              </View>
            )}
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
              <FocusGuide
                remember
                trap={CENTRED_ROW}
                style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                {tv || Platform.OS === 'web' ? (
                  <IconButton
                    ref={playRef}
                    testID="player-toggle"
                    icon={paused ? Play : Pause}
                    accessibilityLabel={pt(paused ? 'controls.play' : 'controls.pause')}
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
                    <IconButton
                      testID="player-back10-tv"
                      icon={RotateCcw}
                      accessibilityLabel={pt('controls.back10')}
                      onFocus={onRowFocus}
                      onBlur={onRowBlur}
                      onPress={() => {
                        controller.seekBy(-10);
                        show('buttons');
                      }}
                    />
                    <IconButton
                      testID="player-forward30-tv"
                      icon={RotateCw}
                      accessibilityLabel={pt('controls.forward30')}
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
                {panelButtons.map((panel) => (
                  <IconButton
                    key={panel}
                    testID={`player-open-${panel}`}
                    icon={PANEL_ICONS[panel]}
                    variant="ghost"
                    accessibilityLabel={pt(`controls.${panel}`)}
                    onFocus={onRowFocus}
                    onBlur={onRowBlur}
                    onPress={() => onPanel(panel)}
                  />
                ))}
                {Platform.OS === 'web' ? (
                  <IconButton
                    testID="player-mute"
                    icon={muted ? VolumeX : Volume2}
                    variant="ghost"
                    accessibilityLabel={pt(muted ? 'controls.unmute' : 'controls.mute')}
                    onPress={toggleMute}
                  />
                ) : null}
                {fullscreenAvailable ? (
                  <IconButton
                    testID="player-fullscreen"
                    icon={fullscreen ? Minimize : Maximize}
                    variant="ghost"
                    accessibilityLabel={pt(
                      fullscreen ? 'controls.exitFullscreen' : 'controls.fullscreen'
                    )}
                    onPress={toggleFullscreen}
                  />
                ) : null}
                {controller.engine?.supportsPictureInPicture ? (
                  <IconButton
                    testID="player-pip"
                    icon={PictureInPicture2}
                    variant="ghost"
                    accessibilityLabel={pt('controls.pip')}
                    onPress={() => controller.engine?.startPictureInPicture?.()}
                  />
                ) : null}
                {!tv && Platform.OS !== 'web' ? (
                  <IconButton
                    testID="player-fit"
                    icon={fit === 'cover' ? Shrink : Expand}
                    variant="ghost"
                    accessibilityLabel={pt(fit === 'cover' ? 'controls.fit' : 'controls.fill')}
                    onPress={() => setFit(fit === 'cover' ? 'contain' : 'cover')}
                  />
                ) : null}
              </FocusGuide>
            </View>
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
        style={{ height, borderRadius: height, backgroundColor: colors.input, overflow: 'hidden' }}>
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
            backgroundColor: colors.accent.DEFAULT,
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
        <FocusLift kind="none">{bar}</FocusLift>
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
  centreBacking: { borderRadius: 999, padding: 6, backgroundColor: colors.scrim.DEFAULT },
  centre: { alignItems: 'center', justifyContent: 'center' },
  topShade: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0 },
});
