import { useId } from 'react';
import { useWindowDimensions } from 'react-native';
import Svg, {
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Mask,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import { colors } from '@/theme';

// Smooth gradients only: rasterised 16× smaller and stretched by the GPU (4K: 0.1 MB instead of a 33 MB CPU bitmap).
const SCALE = 16;

export type RoomRect = { x: number; y: number; width: number; height: number };

/** A fade within the region: opaque at `from`, clear from `to` on (fractions of the region). */
export type RoomFade = { from: { x: number; y: number }; to: { x: number; y: number } };

/** Streamybox's room (TvDesign.backdrop); a `region` (window points) draws only the part behind it, `fades` like a mask. */
export function StreamyboxRoom({
  region,
  fades,
  wash = true,
}: {
  region?: RoomRect;
  fades?: readonly RoomFade[];
  wash?: boolean;
}) {
  const window = useWindowDimensions();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const frame = region ?? { x: 0, y: 0, width: window.width, height: window.height };
  if (frame.width <= 0 || frame.height <= 0 || window.width <= 0 || window.height <= 0) return null;
  // The room lives in a 0..100 window space, so a region shows exactly the room behind it.
  const box = {
    x: (frame.x / window.width) * 100,
    y: (frame.y / window.height) * 100,
    width: (frame.width / window.width) * 100,
    height: (frame.height / window.height) * 100,
  };
  // One spare cell: the raster's whole-pixel size must not leave the region's right and bottom edges uncovered.
  const cells = {
    width: Math.ceil(frame.width / SCALE) + 1,
    height: Math.ceil(frame.height / SCALE) + 1,
  };
  const view = {
    width: ((cells.width * SCALE) / window.width) * 100,
    height: ((cells.height * SCALE) / window.height) * 100,
  };
  const room = (
    <>
      {wash ? <Rect x="0" y="0" width="100" height="100" fill={`url(#wash-${id})`} /> : null}
      <Ellipse cx="50" cy="50" rx="100" ry="100" fill={`url(#bloom-${id})`} />
      <Ellipse cx="50" cy="50" rx="100" ry="100" fill={`url(#vignette-${id})`} />
    </>
  );
  return (
    <Svg
      width={cells.width}
      height={cells.height}
      viewBox={`${box.x} ${box.y} ${view.width} ${view.height}`}
      preserveAspectRatio="none"
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: 0,
        top: 0,
        width: cells.width,
        height: cells.height,
        // Scaled around its centre and shifted, so the raster grows from the region's top-left corner.
        transform: [
          { translateX: ((SCALE - 1) * cells.width) / 2 },
          { translateY: ((SCALE - 1) * cells.height) / 2 },
          { scale: SCALE },
        ],
      }}>
      <Defs>
        <LinearGradient
          id={`wash-${id}`}
          x1="0"
          y1="0"
          x2="0"
          y2="100"
          gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.aurora.wash} />
          <Stop offset="0.5" stopColor={colors.background} />
        </LinearGradient>
        <RadialGradient id={`bloom-${id}`} cx="12" cy="0" r="65" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.accent.DEFAULT} stopOpacity={0.09} />
          <Stop offset="1" stopColor={colors.accent.DEFAULT} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`vignette-${id}`} cx="50" cy="42" r="75" gradientUnits="userSpaceOnUse">
          <Stop offset="0.5" stopColor={colors.video} stopOpacity={0} />
          <Stop offset="1" stopColor={colors.video} stopOpacity={0.43} />
        </RadialGradient>
        {fades?.map((fade, index) => (
          // Fractions of the mask rect (region plus spare cell); user-space fades did not render in Android masks.
          <LinearGradient
            key={`reveal-${index}`}
            id={`reveal-${index}-${id}`}
            x1={(fade.from.x * box.width) / view.width}
            y1={(fade.from.y * box.height) / view.height}
            x2={(fade.to.x * box.width) / view.width}
            y2={(fade.to.y * box.height) / view.height}>
            <Stop offset="0" stopColor={colors.video} stopOpacity={1} />
            <Stop offset="1" stopColor={colors.video} stopOpacity={0} />
          </LinearGradient>
        ))}
        {fades ? (
          <Mask id={`mask-${id}`} maskType="alpha">
            {fades.map((_, index) => (
              <Rect
                key={index}
                x={box.x}
                y={box.y}
                width={view.width}
                height={view.height}
                fill={`url(#reveal-${index}-${id})`}
              />
            ))}
          </Mask>
        ) : null}
      </Defs>
      {fades ? <G mask={`url(#mask-${id})`}>{room}</G> : room}
    </Svg>
  );
}
