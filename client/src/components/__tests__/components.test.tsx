import { act, fireEvent, screen, userEvent } from '@testing-library/react-native';
import { Play } from '@/components/icons';
import { Pressable } from 'react-native';

import { PosterCard } from '@/components/media/poster-card';
import { Shelf } from '@/components/media/shelf';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SheetItem } from '@/components/ui/sheet';
import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Button', () => {
  it('presses, and ignores presses while loading or disabled', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <>
        <Button testID="play" label="x" icon={Play} onPress={onPress} />
        <Button testID="busy" label="y" loading onPress={onPress} />
        <Button testID="off" label="z" disabled onPress={onPress} />
      </>
    );
    const user = userEvent.setup();
    await user.press(screen.getByTestId('play'));
    await user.press(screen.getByTestId('busy'));
    await user.press(screen.getByTestId('off'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('busy')).toBeBusy();
    expect(screen.getByTestId('off')).toBeDisabled();
  });
});

describe('selection state', () => {
  it('Tag and SheetItem expose selected / checked via aria props (react-native-web ignores accessibilityState)', async () => {
    await renderWithProviders(
      <>
        <Tag testID="tag-on" label="a" selected onPress={jest.fn()} />
        <Tag testID="tag-off" label="b" onPress={jest.fn()} />
        <SheetItem label="c" selected onPress={jest.fn()} />
        <SheetItem label="d" onPress={jest.fn()} />
      </>
    );
    expect(screen.getByTestId('tag-on')).toBeSelected();
    expect(screen.getByTestId('tag-off')).not.toBeSelected();
    expect(screen.getByRole('radio', { name: 'c' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'd' })).not.toBeChecked();
  });
});

describe('ErrorState', () => {
  it('maps a known code to its localized message and actions', async () => {
    const onAction = jest.fn();
    await renderWithProviders(
      <ErrorState code="age_restricted" actions={['goHome', 'back']} onAction={onAction} />
    );
    expect(screen.getByText('Not available for this profile')).toBeOnTheScreen();
    expect(screen.getByText('Error code age_restricted')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Go back'));
    expect(onAction).toHaveBeenCalledWith('back');
  });

  it('falls back to a generic message for unknown codes, keeping the code visible', async () => {
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    await renderWithProviders(<ErrorState code="release_exploded" onAction={jest.fn()} />);
    expect(screen.getByText('Etwas ist schiefgelaufen')).toBeOnTheScreen();
    expect(screen.getByText('Fehlercode release_exploded')).toBeOnTheScreen();
    expect(screen.getByText('Erneut versuchen')).toBeOnTheScreen();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });
});

describe('media', () => {
  it('PosterCard exposes title and subtitle to assistive tech and shows progress', async () => {
    await renderWithProviders(
      <PosterCard testID="card" title="Sintel" subtitle="2010" progress={0.4} onPress={jest.fn()} />
    );
    expect(screen.getByTestId('card')).toHaveAccessibleName('Sintel, 2010');
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('40% watched');
  });

  it('Shelf renders its title and items', async () => {
    const items = Array.from({ length: 4 }, (_, index) => `item-${index}`);
    await renderWithProviders(
      <Shelf
        title="Row"
        memoryKey="test.row"
        data={items}
        keyExtractor={(item) => item}
        itemWidth={100}
        artworkHeight={150}
        renderItem={({ item }) => (
          <Pressable testID={item}>
            <Text>{item}</Text>
          </Pressable>
        )}
      />
    );
    expect(screen.getByText('Row')).toBeOnTheScreen();
    expect(screen.getByTestId('item-3')).toBeOnTheScreen();
  });

  it('ProgressBar clamps and reports its value', async () => {
    await renderWithProviders(<ProgressBar value={1.7} />);
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
    });
  });
});

describe('overlays', () => {
  it('Dialog shows title, message and actions', async () => {
    const onClose = jest.fn();
    await renderWithProviders(
      <Dialog
        open
        onClose={onClose}
        title="Remove?"
        message="Progress is kept."
        actions={[{ label: 'Cancel', onPress: onClose }]}
      />
    );
    expect(screen.getByText('Remove?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Toast shows a message', async () => {
    function Trigger() {
      const toast = useToast();
      return (
        <Button
          testID="trigger"
          label="t"
          onPress={() => toast.show({ message: 'Saved', tone: 'success' })}
        />
      );
    }
    await renderWithProviders(<Trigger />);
    await fireEvent.press(screen.getByTestId('trigger'));
    expect(screen.getByRole('alert')).toHaveTextContent('Saved');
  });
});
