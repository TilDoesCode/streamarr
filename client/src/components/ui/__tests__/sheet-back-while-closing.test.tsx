import { act, type ReactNode } from 'react';
import { Text } from 'react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { Sheet } from '../sheet';

const mockModal = { props: {} as { visible?: boolean; onRequestClose?: () => void } };
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  function Modal(props: { visible?: boolean; onRequestClose?: () => void; children?: ReactNode }) {
    mockModal.props = props;
    return props.visible ? <View>{props.children}</View> : null;
  }
  return { __esModule: true, default: Modal };
});

describe('Sheet Back while the exit animation runs (TV Back chain, P3)', () => {
  it('hands a Back during the exit on to the screen and drops the closing Modal at once', async () => {
    const onClose = jest.fn();
    const onBackWhileClosing = jest.fn();
    const sheet = (open: boolean) => (
      <Sheet
        open={open}
        onClose={onClose}
        title="Subtitles"
        onBackWhileClosing={onBackWhileClosing}>
        <Text>Off</Text>
      </Sheet>
    );
    const { rerender } = await renderWithProviders(sheet(true));
    mockModal.props.onRequestClose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBackWhileClosing).not.toHaveBeenCalled();

    await rerender(sheet(false));
    expect(mockModal.props.visible).toBe(true);
    await act(async () => mockModal.props.onRequestClose?.());
    expect(onBackWhileClosing).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockModal.props.visible).toBe(false);
  });

  it('a second Back before the re-render goes to the screen, not to the closing sheet (Google TV, S4b)', async () => {
    const onClose = jest.fn();
    const onBackWhileClosing = jest.fn();
    await renderWithProviders(
      <Sheet open onClose={onClose} title="Subtitles" onBackWhileClosing={onBackWhileClosing}>
        <Text>Off</Text>
      </Sheet>
    );
    const request = mockModal.props.onRequestClose;
    request?.();
    request?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBackWhileClosing).toHaveBeenCalledTimes(1);
  });
});
