import { verdictFor, type SpeedVerdict } from './speed-test';

/** Which leg of Usenet → server → device limits playback. */
export type PathBottleneck = 'device' | 'usenet' | 'even';

export type PathVerdict =
  | { kind: 'none' }
  | { kind: 'deviceOnly' | 'usenetOnly'; limitMbps: number; tier: SpeedVerdict }
  | { kind: 'both'; bottleneck: PathBottleneck; limitMbps: number; tier: SpeedVerdict };

/** Legs within this ratio of each other count as even. */
const EVEN_RATIO = 0.9;

/**
 * The slower measured leg decides; the tier says what plays smoothly at that speed (with the shared headroom).
 * A device speed that is only a lower bound (the test hit its ceiling) never makes the device the bottleneck.
 */
export function pathVerdict(
  usenetMbps?: number,
  deviceMbps?: number,
  deviceLimited?: boolean
): PathVerdict {
  const usenet = usenetMbps && usenetMbps > 0 ? usenetMbps : undefined;
  const device = deviceMbps && deviceMbps > 0 ? deviceMbps : undefined;
  if (usenet === undefined && device === undefined) return { kind: 'none' };
  if (usenet === undefined)
    return { kind: 'deviceOnly', limitMbps: device!, tier: verdictFor(device!) };
  if (device === undefined)
    return { kind: 'usenetOnly', limitMbps: usenet, tier: verdictFor(usenet) };
  const limit = Math.min(usenet, device);
  const bottleneck: PathBottleneck =
    Math.min(usenet, device) / Math.max(usenet, device) >= EVEN_RATIO ||
    (deviceLimited && device < usenet)
      ? 'even'
      : device < usenet
        ? 'device'
        : 'usenet';
  return { kind: 'both', bottleneck, limitMbps: limit, tier: verdictFor(limit) };
}
