import { screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { Version } from '@/browse/queries';
import { versionHeadline } from '@/browse/version-format';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { VersionChips } from '../version-chips';

const mockWindow = { width: 1920, height: 1080, scale: 1, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const version = {
  releaseId: 'r1',
  rank: 1,
  recommended: true,
  resolution: '1080p',
  videoCodec: 'h264',
  audioCodec: 'ac3',
  audioChannels: '5.1',
  source: 'BluRay',
  sizeBytes: 8_000_000_000,
} as unknown as Version;

const chipText = (key: string) => {
  const text = within(screen.getByTestId(`play-chips-${key}`)).getByText(/./);
  return { text: text.props.children as string, style: StyleSheet.flatten(text.props.style) };
};

describe('stage chip row casing (Q2-06)', () => {
  it('names the source like the versions sheet ("BluRay", not "BLURAY")', async () => {
    await renderWithProviders(
      <VersionChips
        target={{
          state: 'ready',
          version,
          method: 'remux',
          isLastPlayed: false,
          lastPlayedMissing: false,
        }}
        versions={[version]}
      />
    );
    const source = chipText('source');
    expect(source.text).toBe('BluRay');
    expect(source.style.textTransform).not.toBe('uppercase');
    // The sheet's headline ("1080p · BluRay") carries the same word.
    expect(versionHeadline(version).split(' · ')).toContain(source.text);
    // Codec chips keep the spec caps.
    expect(chipText('video').style.textTransform).toBe('uppercase');
  });
});
