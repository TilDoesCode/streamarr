import { screen } from '@testing-library/react-native';
import { PixelRatio } from 'react-native';

import { EpisodeStrip } from '@/browse/episode-strip';
import type { Episode } from '@/browse/queries';
import { LandscapeCard } from '@/components/media/landscape-card';
import { PosterCard } from '@/components/media/poster-card';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

type Node = { props?: { recyclingKey?: string }; children?: readonly (Node | string)[] };

/** Every image URI drawn inside a test id (Artwork keys the native image by its URI). */
function imageUris(testID: string): string[] {
  const found: string[] = [];
  const walk = (node: Node | string) => {
    if (typeof node === 'string') return;
    const uri = node.props?.recyclingKey;
    if (uri) found.push(uri);
    for (const child of node.children ?? []) walk(child);
  };
  walk(screen.getByTestId(testID) as unknown as Node);
  return found;
}

const poster = { small: 'p-w185', medium: 'p-w342', large: 'p-w780' };
const still = { small: 's-w300', medium: 's-w780', large: 's-w1280' };

beforeAll(async () => {
  await i18n.changeLanguage('de');
});
afterEach(() => jest.restoreAllMocks());

describe('cards load the size class that fits (B10)', () => {
  it('a poster card at 1x loads small, at DPR 2 medium', async () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(1);
    const view = await renderWithProviders(
      <PosterCard testID="card" title="Sintel" imageUri="plain" imageSizes={poster} width={139} />
    );
    expect(imageUris('card')).toEqual(['p-w185']);
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
    await view.rerender(
      <PosterCard testID="card" title="Sintel" imageUri="plain" imageSizes={poster} width={140} />
    );
    expect(imageUris('card')).toEqual(['p-w342']);
  });

  it('a landscape card falls back to the plain URL without size classes', async () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(1);
    await renderWithProviders(
      <>
        <LandscapeCard testID="sized" title="E1" imageUri="plain" imageSizes={still} width={235} />
        <LandscapeCard testID="old" title="E1" imageUri="plain" width={235} />
      </>
    );
    expect(imageUris('sized')).toEqual(['s-w300']);
    expect(imageUris('old')).toEqual(['plain']);
  });

  it('the episode strip loads stills by card width, not the full w1280', async () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
    const episodes = [1, 2].map(
      (n) =>
        ({
          workId: `w${n}`,
          episodeNumber: n,
          title: `E${n}`,
          aired: true,
          stillUrl: 'plain',
          stillSizes: still,
          watch: { played: false },
        }) as unknown as Episode
    );
    await renderWithProviders(
      <EpisodeStrip
        episodes={episodes}
        selected={1}
        scrollKey="1"
        gutterStart={101}
        gutterEnd={58}
        onPreview={jest.fn()}
        onSelect={jest.fn()}
        onPlay={jest.fn()}
        onVersions={jest.fn()}
      />
    );
    // Card 352 × shell scale (jest window 750 → 0.6) ≈ 211 pt × 2 × focus lift → w780.
    expect(imageUris('episode-card-1')).toEqual(['s-w780']);
    expect(imageUris('episode-card-2')).toEqual(['s-w780']);
  });
});
