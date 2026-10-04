import type { Version } from '@/browse/queries';

import {
  audioLayout,
  audioSpec,
  audioTransfer,
  barChipsLabelled,
  betterVersion,
  channelLayout,
  containerTransfer,
  qualityLabel,
  stepDownKey,
  videoTransfer,
  LARGE_TITLE_MAX_WIDTH,
  subtitleFormat,
  subtitleLabel,
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

describe('audio labels with renditions', () => {
  const german = { index: 1, codec: 'ac3', channels: 6, deliveredAs: 'remux' } as never;
  const rendition = {
    id: '1',
    streamIndex: 1,
    language: 'de',
    label: 'Deutsch · AAC 2.0',
    channels: 2,
    codec: 'aac',
    default: true,
  };

  it('chip layout, panel spec and info all describe what the session delivers', () => {
    expect(audioLayout(german, rendition)).toBe('2.0');
    expect(audioSpec(german, rendition)).toBe('AAC 2.0');
    expect(audioTransfer(german, rendition)).toBe('Dolby Digital 5.1 → AAC 2.0');
    expect(audioSpec(german)).toBe('Dolby Digital 5.1');
  });
});

describe('subtitle labels (Q1-15)', () => {
  const sherlock = [
    {
      index: 3,
      codec: 'ass',
      language: 'ger',
      title: 'Deutsch (forced)',
      forced: true,
      deliveredAs: 'webvtt',
    },
    {
      index: 4,
      codec: 'ass',
      language: 'ger',
      title: 'Deutsch (styled)',
      forced: false,
      deliveredAs: 'webvtt',
    },
    {
      index: 5,
      codec: 'subrip',
      language: 'eng',
      title: 'English',
      forced: false,
      deliveredAs: 'webvtt',
    },
  ];
  const names: Record<string, string> = { ger: 'Deutsch', eng: 'Englisch' };
  const label = (index: number, tracks = sherlock) =>
    subtitleLabel(
      tracks.find((track) => track.index === index)!,
      tracks,
      (code) => names[code]!,
      'Spur'
    );

  it('names the language only when forced or format already tell the tracks apart', () => {
    expect(label(3)).toBe('Deutsch');
    expect(label(4)).toBe('Deutsch');
    expect(label(5)).toBe('Englisch');
  });

  it('adds the file title for two tracks of one language, kind and format', () => {
    const sdh = [...sherlock, { ...sherlock[1]!, index: 6, title: 'SDH' }];
    expect(label(4, sdh)).toBe('Deutsch · Deutsch (styled)');
    expect(label(6, sdh)).toBe('Deutsch · SDH');
  });

  it('shows readable formats instead of raw codec ids', () => {
    expect(subtitleFormat('subrip')).toBe('SRT');
    expect(subtitleFormat('SUBRIP')).toBe('SRT');
    expect(subtitleFormat('hdmv_pgs_subtitle')).toBe('PGS');
    expect(subtitleFormat('ass')).toBe('ASS');
    expect(subtitleFormat(null)).toBe('');
  });
});

describe('large player title (Q1-13)', () => {
  it('fits "Sherlock · S2, F2 · Die Hunde von Baskerville" on one line at 1280 px', () => {
    const scale = 1280 / 1920;
    const bar = 1280 - 2 * 96 * scale;
    const title = 'Sherlock · S2, F2 · Die Hunde von Baskerville';
    // Display bold averages ~0.5 em per character.
    const needed = title.length * 0.5 * 56 * scale;
    expect((parseFloat(LARGE_TITLE_MAX_WIDTH) / 100) * bar).toBeGreaterThan(needed);
    expect(0.62 * bar).toBeLessThan(needed);
  });
});
