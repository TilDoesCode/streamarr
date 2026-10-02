import type { Version } from '@/browse/queries';

import {
  audioTransfer,
  barChipsLabelled,
  betterVersion,
  channelLayout,
  containerTransfer,
  qualityLabel,
  stepDownKey,
  videoTransfer,
} from '../overlay-labels';

const version = (releaseId: string, prediction: string, rank: number) =>
  ({ releaseId, rank, predictedMethod: prediction }) as unknown as Version;

describe('overlay labels', () => {
  it('formats channel layouts and quality chips', () => {
    expect(channelLayout(6)).toBe('5.1');
    expect(channelLayout(8)).toBe('7.1');
    expect(channelLayout(2)).toBe('2.0');
    expect(qualityLabel(2160, 'hdr10')).toBe('4K HDR');
    expect(qualityLabel(1080, 'sdr')).toBe('1080p');
    expect(qualityLabel(1080, 'SDR')).toBe('1080p');
  });

  it('shows source → delivered only when the server changes the stream', () => {
    expect(
      videoTransfer({
        index: 0,
        codec: 'hevc',
        bitDepth: 10,
        width: 3840,
        height: 2160,
        hdr: 'hdr10',
        deliveredCodec: 'h264',
        deliveredHeight: 1080,
      })
    ).toMatch(/^HEVC 10-bit HDR10 2160p → H\.264 1080p SDR$/);
    // A source whose stream tags read SDR keeps its HDR format name (Dev World BBB 4K, I3).
    expect(
      videoTransfer({
        index: 0,
        codec: 'hevc',
        bitDepth: 10,
        width: 3840,
        height: 2160,
        hdr: 'hdr10',
        videoRange: 'SDR',
        deliveredCodec: 'h264',
        deliveredHeight: 1080,
      })
    ).toBe('HEVC 10-bit HDR10 2160p → H.264 1080p SDR');
    expect(
      audioTransfer({
        index: 1,
        codec: 'truehd',
        channels: 8,
        deliveredAs: null,
        deliveredCodec: 'aac',
        deliveredChannels: 2,
      })
    ).toMatch(/→ AAC 2\.0$/);
    expect(audioTransfer({ index: 1, codec: 'aac', channels: 2, deliveredAs: null })).not.toMatch(
      /→/
    );
    expect(containerTransfer('mkv', 'transcode')).toBe('MKV → HLS');
    expect(containerTransfer('mp4', 'direct')).toBe('MP4');
  });

  it('suggests a version that plays with less work', () => {
    const list = [version('a', 'transcode', 1), version('b', 'direct', 2)];
    expect(betterVersion(list, 'a', 'transcode')?.releaseId).toBe('b');
    expect(betterVersion(list, 'b', 'direct')).toBeUndefined();
  });
});

describe('stepDownKey', () => {
  it('names what changed from the viewer side, never raw method names', () => {
    expect(stepDownKey({ from: 'direct', to: 'direct', engine: 'vlc' })).toBe('notice.stepDownVlc');
    expect(stepDownKey({ from: 'remux', to: 'transcode', engine: '' })).toBe(
      'notice.stepDownTranscode'
    );
    expect(stepDownKey({ from: 'direct', to: 'remux' })).toBe('notice.stepDownRemux');
    expect(stepDownKey({ to: 'odd' })).toBe('notice.stepDown');
  });
});

describe('barChipsLabelled', () => {
  it('keeps text chips on TV and wide windows, icons only on iPad mini/Air portrait', () => {
    expect(barChipsLabelled(1920, true)).toBe(true);
    expect(barChipsLabelled(1032, false)).toBe(true);
    expect(barChipsLabelled(820, false)).toBe(false);
    expect(barChipsLabelled(744, false)).toBe(false);
  });
});
