import { screen, within } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import { Platform } from 'react-native';

import { IconButton } from '@/components/ui/icon-button';
import { TextField } from '@/components/ui/text-field';

import { renderWithProviders } from '../../../../jest/render';

const clear = (
  <IconButton testID="clear" icon={X} size="sm" variant="ghost" accessibilityLabel="Clear" />
);

afterEach(() => jest.restoreAllMocks());

describe('TextField trailing control (Q1-12)', () => {
  it('sits inside the field box, so showing it does not resize the field', async () => {
    const { rerender } = await renderWithProviders(
      <TextField testID="field" label="Search" value="" />
    );
    const before = screen.getByTestId('field-box');
    expect(before).toHaveStyle({ flex: 1 });
    await rerender(<TextField testID="field" label="Search" value="a" trailing={clear} />);
    const box = screen.getByTestId('field-box');
    expect(within(box).getByTestId('clear')).toBeOnTheScreen();
    expect(box).toHaveStyle({ flex: 1 });
  });

  it('keeps it beside the field on TV (its own focus stop)', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await renderWithProviders(<TextField testID="field" label="Search" trailing={clear} />);
    const field = screen.getByTestId('field-field');
    expect(within(field).queryByTestId('clear')).toBeNull();
    expect(screen.getByTestId('clear')).toBeOnTheScreen();
  });
});

describe('TextField hidden label (Q1-21)', () => {
  it('names the input without showing the label', async () => {
    await renderWithProviders(<TextField testID="field" label="Search" labelHidden />);
    expect(screen.queryByText('Search')).toBeNull();
    expect(screen.getByTestId('field')).toHaveAccessibleName('Search');
  });
});
