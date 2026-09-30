import type { components } from '@/api/schema';

export type CatalogSpec = components['schemas']['CatalogSpecDto'];
export type SpecTone = 'neutral' | 'ok' | 'info' | 'warn' | 'bad';

/** Display-ready chips of an R0 spec summary, in reading order; empty when the server has none yet. */
export function specChips(spec: CatalogSpec | null | undefined): string[] {
  if (!spec) return [];
  return [spec.resolution, spec.hdr, spec.videoCodec, spec.audio]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value.length > 0);
}

/** Playback method → chip colour (Aurora ok/warn/bad; direct stream is informational). */
export function methodTone(method: string | null | undefined): SpecTone {
  switch (method) {
    case 'direct':
    case 'vlc':
      return 'ok';
    case 'remux':
      return 'info';
    case 'transcode':
      return 'warn';
    default:
      return 'neutral';
  }
}

export type SignalLevel = 0 | 1 | 2 | 3 | 4;
export type Signal = { level: SignalLevel; tone: SpecTone };

/** Health and local (pre-download) state → signal bars; null when nothing is known yet. */
export function versionSignal({
  health,
  local,
}: {
  health?: string | null;
  local?: string | null;
}): Signal | null {
  if (local === 'ready') return { level: 4, tone: 'ok' };
  if (local === 'downloading') return { level: 2, tone: 'info' };
  if (health === 'ready') return { level: 4, tone: 'ok' };
  if (health === 'degraded') return { level: 2, tone: 'warn' };
  if (health === 'failed' || health === 'dead') return { level: 1, tone: 'bad' };
  return null;
}
