import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { StreamyboxRoom, type RoomFade, type RoomRect } from '@/components/ambient/streamybox-room';
import { withAlpha } from '@/lib/color';
import { colors, theme } from '@/theme';

import * as masked from './hero-fade-masked';

// Android MaskedView rasterises full-size masks on the CPU (4K on TV boxes); Streamybox covers the art with its own room.
const SBX = theme === 'streamybox';
const ROOM = colors.background;
const BOTTOM: RoomFade = { from: { x: 0, y: 1 }, to: { x: 0, y: 0.4 } };
const LEFT: RoomFade = { from: { x: 0, y: 0 }, to: { x: 0.6, y: 0 } };

function RoomHeroFade({ children, left = true }: { children: ReactNode; left?: boolean }) {
  const window = useWindowDimensions();
  const [region, setRegion] = useState<RoomRect | null>(null);
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={({ nativeEvent: { layout } }) =>
        // Every large-screen hero hangs from the window's top-right corner.
        setRegion({
          x: window.width - layout.width,
          y: 0,
          width: layout.width,
          height: layout.height,
        })
      }>
      {children}
      {region ? <StreamyboxRoom region={region} fades={left ? [BOTTOM, LEFT] : [BOTTOM]} /> : null}
    </View>
  );
}

// Its unmasked bottom edge lies below the art, where the wash darkens the room with the room colour.
function RoomCopyWash({ color }: { color: string }) {
  return (
    <LinearGradient
      style={StyleSheet.absoluteFill}
      colors={[color, withAlpha(ROOM, 0)]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
    />
  );
}

export const HeroFade = SBX ? RoomHeroFade : masked.HeroFade;
export const CopyWash = SBX ? RoomCopyWash : masked.CopyWash;
