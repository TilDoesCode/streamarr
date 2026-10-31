import { act, fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { deviceSettings } from '@/lib/storage';
import { useLiteMode, writePerformancePreference } from '@/performance';
import { PerformanceRow } from '@/screens/settings/settings-screen';
import { renderWithProviders } from '@/../jest/render';

function LiteReader() {
  return <Text>{useLiteMode() ? 'lite' : 'full'}</Text>;
}

afterEach(() => writePerformancePreference('auto'));

describe('PerformanceRow', () => {
  it('shows the new choice while many cards read the mode (BASE 18:12: chip stayed on the old value)', async () => {
    await renderWithProviders(
      <>
        {Array.from({ length: 40 }, (_, index) => (
          <LiteReader key={index} />
        ))}
        <PerformanceRow />
      </>
    );
    await act(async () => fireEvent.press(screen.getByTestId('settings-performance-off')));
    expect(screen.getByTestId('settings-performance-off')).toBeChecked();
    expect(screen.getByTestId('settings-performance-current')).toHaveTextContent(/Aus|Off/);
    expect(screen.queryAllByText('lite')).toHaveLength(0);
  });

  it('follows a value written to the device store directly', async () => {
    await renderWithProviders(<PerformanceRow />);
    await act(async () => deviceSettings.set('performanceMode', 'on'));
    expect(screen.getByTestId('settings-performance-on')).toBeChecked();
    expect(screen.getByTestId('settings-performance-auto')).not.toBeChecked();
  });
});
