import { useEffect, useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { colors, motion, theme } from '@/theme';

import { AmbientImage } from './ambient-image';
import { ambientScene, type AmbientInput, type AmbientScene } from './ambient-model';
import { useAmbientTitle } from './ambient-provider';

const EASE = Easing.inOut(Easing.quad);

/** Full-screen Aurora backdrop: blurred artwork of the focused/hovered title plus tint washes, crossfading. */
function AuroraBackdrop({ title, testID }: { title?: AmbientInput | null; testID?: string }) {
  const fromContext = useAmbientTitle();
  const { key, image, tint, tint2, neutral } = ambientScene(
    title !== undefined ? title : fromContext
  );
  const [layers, setLayers] = useState<AmbientScene[]>(() => [
    { key, image, tint, tint2, neutral },
  ]);
  const top = layers[layers.length - 1]?.key;

  // Debounced: quick focus moves only paint the title the focus settles on.
  useEffect(() => {
    if (key === top) return;
    const next = { key, image, tint, tint2, neutral };
    const timer = setTimeout(
      () => setLayers((current) => [...current.slice(-1), next]),
      motion.ambientDebounce
    );
    return () => clearTimeout(timer);
  }, [key, image, tint, tint2, neutral, top]);

  useEffect(() => {
    if (layers.length < 2) return;
    const timer = setTimeout(() => setLayers((current) => current.slice(-1)), motion.ambient + 50);
    return () => clearTimeout(timer);
  }, [layers]);

  return (
    <View
      testID={testID}
      pointerEvents="none"
      // Clips the scaled, blurred art (web pages grew ~7.5 % wider); it never contains glass.
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, overflow: 'hidden' }]}>
      {layers.map((layer, index) => (
        <AmbientLayer key={layer.key} scene={layer} animateIn={index > 0} />
      ))}
    </View>
  );
}

function AmbientLayer({ scene, animateIn }: { scene: AmbientScene; animateIn: boolean }) {
  // Per-layer gradient ids: on web, SVG ids are document-global and the incoming layer would reuse the old tint.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const opacity = useSharedValue(animateIn ? 0 : 1);
  useEffect(() => {
    opacity.set(withTiming(1, { duration: motion.ambient, easing: EASE }));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      testID={scene.neutral ? 'ambient-layer-neutral' : 'ambient-layer-tinted'}
      style={[StyleSheet.absoluteFill, style]}>
      {scene.image ? <AmbientImage uri={scene.image} /> : null}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim.DEFAULT, opacity: 0.62 }]}
      />
      <Svg
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`tint-${id}`} cx="18" cy="12" r="70" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={scene.tint} stopOpacity={scene.neutral ? 0.35 : 0.42} />
            <Stop offset="1" stopColor={scene.tint} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`tint2-${id}`} cx="88" cy="92" r="75" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={scene.tint2} stopOpacity={0.7} />
            <Stop offset="1" stopColor={scene.tint2} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="50" rx="100" ry="100" fill={`url(#tint2-${id})`} />
        <Ellipse cx="50" cy="50" rx="100" ry="100" fill={`url(#tint-${id})`} />
      </Svg>
    </Animated.View>
  );
}

/** Streamybox: the system backdrop (TvDesign.backdrop): blue-black gradient, faint accent bloom, vignette. */
function StreamyboxBackdrop({ testID }: { title?: AmbientInput | null; testID?: string }) {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={[colors.aurora.wash, colors.background, colors.background]}
      />
      <Svg
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id="sbx-bloom" cx="12" cy="0" r="65" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={colors.accent.DEFAULT} stopOpacity={0.09} />
            <Stop offset="1" stopColor={colors.accent.DEFAULT} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="sbx-vignette" cx="50" cy="42" r="75" gradientUnits="userSpaceOnUse">
            <Stop offset="0.5" stopColor={colors.video} stopOpacity={0} />
            <Stop offset="1" stopColor={colors.video} stopOpacity={0.43} />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="50" rx="100" ry="100" fill="url(#sbx-bloom)" />
        <Ellipse cx="50" cy="50" rx="100" ry="100" fill="url(#sbx-vignette)" />
      </Svg>
    </View>
  );
}

export const AmbientBackdrop = theme === 'streamybox' ? StreamyboxBackdrop : AuroraBackdrop;
