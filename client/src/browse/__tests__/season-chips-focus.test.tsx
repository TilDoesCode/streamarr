import { screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { SeasonChips } from '@/browse/season-chips';

const mockGuides: { testID?: string; destinations?: readonly unknown[]; remember?: boolean }[] = [];
jest.mock('@/components/focus', () => {
  const actual = jest.requireActual('@/components/focus');
  return {
    ...actual,
    FocusGuide: (props: {
      testID?: string;
      destinations?: unknown[];
      remember?: boolean;
      children?: ReactNode;
    }) => {
      mockGuides.push({
        testID: props.testID,
        destinations: props.destinations,
        remember: props.remember,
      });
      const { View: NativeView } = jest.requireActual('react-native');
      return <NativeView testID={props.testID}>{props.children}</NativeView>;
    },
  };
});

describe('season chips focus entry (Q1-54)', () => {
  it('points the chip row at the active season, so Down from the main button lands there', async () => {
    const seasons = [1, 2, 3].map((seasonNumber) => ({
      seasonNumber,
      episodeCount: 3,
      playedCount: 0,
    }));
    await renderWithProviders(
      <SeasonChips seasons={seasons as never} season={3} onSeason={() => undefined} />
    );
    const last = mockGuides.filter((guide) => guide.testID === 'series-seasons').at(-1);
    expect(last?.destinations).toHaveLength(1);
    expect(last?.destinations?.[0]).toBeTruthy();
    // tvOS: a remembering guide ignores its destinations.
    expect(last?.remember).toBe(false);
    expect(screen.getByTestId('season-3')).toBeOnTheScreen();
  });
});
