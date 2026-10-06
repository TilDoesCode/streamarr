import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Spinner } from '@/components/ui/spinner';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

const mockReduced = { value: false };
jest.mock('react-native-reanimated', () => {
  const mock = jest.requireActual('react-native-reanimated/mock');
  return { ...mock, useReducedMotion: () => mockReduced.value, makeMutable: mock.useSharedValue };
});

const styleOf = () =>
  StyleSheet.flatten(screen.getByTestId('loader', { includeHiddenElements: true }).props.style);

describe('spinner under reduced motion (verify V1 V25)', () => {
  it('turns at 800 ms per round normally', async () => {
    mockReduced.value = false;
    await renderWithProviders(<Spinner testID="loader" />);
    expect(styleOf()).toMatchObject({ animationDuration: '800ms' });
    expect(styleOf().animationName).toBeDefined();
  });

  it('keeps turning (the rotation carries the meaning) at half the speed', async () => {
    mockReduced.value = true;
    await renderWithProviders(<Spinner testID="loader" />);
    expect(styleOf()).toMatchObject({ animationDuration: '1600ms' });
    expect(styleOf().animationName).toBeDefined();
  });
});
