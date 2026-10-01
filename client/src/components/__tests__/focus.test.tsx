import { fireEvent, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { Focusable, FocusGuide, FocusLift, FocusSection } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { renderWithProviders } from '@/../jest/render';

describe('Focusable', () => {
  it('forwards focus, blur and presses', async () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    const onPress = jest.fn();
    await renderWithProviders(
      <Focusable testID="item" onFocus={onFocus} onBlur={onBlur} onPress={onPress}>
        <FocusLift kind="card">
          <Text>{'x'}</Text>
        </FocusLift>
      </Focusable>
    );
    const item = screen.getByTestId('item');
    await fireEvent(item, 'focus', {});
    expect(onFocus).toHaveBeenCalledTimes(1);
    await fireEvent(item, 'blur', {});
    expect(onBlur).toHaveBeenCalledTimes(1);
    await fireEvent.press(item);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(item.props.focusable).toBe(true);
  });

  it('reports iPad pointer hover (pointer events, mouse only) as onHoverIn/onHoverOut', async () => {
    const onHoverIn = jest.fn();
    const onHoverOut = jest.fn();
    await renderWithProviders(
      <Focusable testID="card" onHoverIn={onHoverIn} onHoverOut={onHoverOut} onPress={jest.fn()}>
        <Text>{'x'}</Text>
      </Focusable>
    );
    const card = screen.getByTestId('card');
    await fireEvent(card, 'pointerEnter', { nativeEvent: { pointerType: 'touch' } });
    expect(onHoverIn).not.toHaveBeenCalled();
    await fireEvent(card, 'pointerEnter', { nativeEvent: { pointerType: 'mouse' } });
    await fireEvent(card, 'pointerLeave', { nativeEvent: { pointerType: 'mouse' } });
    expect(onHoverIn).toHaveBeenCalledTimes(1);
    expect(onHoverOut).toHaveBeenCalledTimes(1);
  });

  it('is not focusable when disabled or rendered as a static preview', async () => {
    await renderWithProviders(
      <>
        <Focusable testID="disabled" disabled onPress={jest.fn()}>
          <Text>{'a'}</Text>
        </Focusable>
        <Focusable testID="preview" previewState="focused" onPress={jest.fn()}>
          <Text>{'b'}</Text>
        </Focusable>
      </>
    );
    expect(screen.getByTestId('disabled').props.focusable).toBe(false);
    expect(screen.getByTestId('preview').props.focusable).toBe(false);
  });

  it('only requests preferred focus on TV', async () => {
    expect(Platform.isTV).toBeFalsy();
    await renderWithProviders(
      <Focusable testID="item" hasTVPreferredFocus onPress={jest.fn()}>
        <Text>{'x'}</Text>
      </Focusable>
    );
    expect(screen.getByTestId('item').props.hasTVPreferredFocus).toBeUndefined();
  });
});

describe('FocusGuide', () => {
  it('renders a plain View off TV (no TV-only props leak)', async () => {
    await renderWithProviders(
      <FocusGuide testID="guide" remember trap={['right']}>
        <Text>{'x'}</Text>
      </FocusGuide>
    );
    const guide = screen.getByTestId('guide');
    expect(guide.props.autoFocus).toBeUndefined();
    expect(guide.props.trapFocusRight).toBeUndefined();
  });
});

describe('FocusSection', () => {
  it('adds no TV snapping off TV', async () => {
    await renderWithProviders(
      <FocusSection testID="section">
        <Focusable testID="item" onPress={jest.fn()}>
          <Text>{'x'}</Text>
        </Focusable>
      </FocusSection>
    );
    expect(screen.getByTestId('section').props.scrollSnapAlign).toBeUndefined();
    expect(screen.getByTestId('item').props.scrollSnapAlign).toBeUndefined();
  });
});
