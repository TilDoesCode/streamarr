import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { SpecLabels } from '@/components/spec';
import { specCase, Text } from '@/components/ui/text';
import { renderWithProviders } from '@/../jest/render';

describe('spec text case (Q1-14)', () => {
  it('upper-cases spec labels but keeps resolution suffixes lower case', () => {
    expect(specCase('1080p')).toBe('1080p');
    expect(specCase('720p')).toBe('720p');
    expect(specCase('2160p')).toBe('2160p');
    expect(specCase('1080i')).toBe('1080i');
    expect(specCase('4k')).toBe('4K');
    expect(specCase('hevc')).toBe('HEVC');
    expect(specCase('Dolby Vision')).toBe('DOLBY VISION');
  });

  it('renders "1080p" without a CSS uppercase transform', async () => {
    await renderWithProviders(
      <>
        <SpecLabels
          testID="specs"
          spec={{ resolution: '1080p', hdr: 'HDR10', videoCodec: null, audio: null } as never}
        />
        <Text variant="spec" testID="raw">
          720p
        </Text>
      </>
    );
    for (const node of [screen.getByText('1080p'), screen.getByTestId('raw')]) {
      expect(StyleSheet.flatten(node.props.style).textTransform).not.toBe('uppercase');
    }
    expect(screen.getByText('720p')).toBeTruthy();
    expect(screen.getByText('HDR10')).toBeTruthy();
  });
});
