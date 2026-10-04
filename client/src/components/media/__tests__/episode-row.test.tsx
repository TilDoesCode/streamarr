import { screen } from '@testing-library/react-native';

import { EpisodeRow } from '@/components/media/episode-row';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('episode row watch state (Q1-27)', () => {
  it('shows the watched mark and the resume progress of a replay together', async () => {
    await renderWithProviders(
      <EpisodeRow
        testID="episode-2"
        episodeNumber={2}
        title="E2"
        played
        progress={0.9}
        onPress={() => {}}
      />
    );
    expect(screen.getByLabelText(i18n.t('a11y.played'))).toBeOnTheScreen();
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
  });
});
