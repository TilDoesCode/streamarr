import { act, fireEvent, screen } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pressable, StyleSheet } from 'react-native';

import { LoaderMotionContext } from '@/components/ui/loader-motion';
import { Spinner } from '@/components/ui/spinner';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { useCloseAfterFrame } from '@/screens/player/closing';

/** The player's close: a Back button, its spinner and the navigation that unmounts it. */
function Player({ leave, frame }: { leave: () => void; frame: (run: () => void) => void }) {
  const { closing, closeAfterFrame } = useCloseAfterFrame(frame);
  return (
    <LoaderMotionContext value={!closing}>
      <Spinner testID="spinner" />
      <Pressable testID="close" onPress={() => closeAfterFrame(leave)} />
    </LoaderMotionContext>
  );
}

const animation = () =>
  StyleSheet.flatten(screen.getByTestId('spinner', { includeHiddenElements: true }).props.style)
    .animationName;

describe('closing the player stops its loaders before the screen goes (F12-1, R1 logs)', () => {
  it('Close renders the spinner without its animation first; the navigation that unmounts follows a frame later', async () => {
    const frames: (() => void)[] = [];
    const order: string[] = [];
    const leave = jest.fn(() =>
      order.push(`leave:${animation() === undefined ? 'stopped' : 'running'}`)
    );
    await renderWithProviders(<Player leave={leave} frame={(run) => void frames.push(run)} />);
    expect(animation()).toBeDefined();
    await act(async () => fireEvent.press(screen.getByTestId('close')));
    expect(animation()).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
    await act(async () => frames.forEach((run) => run()));
    expect(order).toEqual(['leave:stopped']);
  });

  it('a second Close before the frame does not navigate twice; an unmount before the frame cancels it', async () => {
    const frames: (() => void)[] = [];
    const leave = jest.fn();
    const view = await renderWithProviders(
      <Player leave={leave} frame={(run) => void frames.push(run)} />
    );
    await act(async () => fireEvent.press(screen.getByTestId('close')));
    await act(async () => fireEvent.press(screen.getByTestId('close')));
    expect(frames).toHaveLength(1);
    await view.unmount();
    frames.forEach((run) => run());
    expect(leave).not.toHaveBeenCalled();
  });

  it('the play screen closes through it and wraps its content in the loader switch', () => {
    const source = readFileSync(join(__dirname, '../play-screen.tsx'), 'utf8');
    expect(source).toMatch(/<LoaderMotionContext value=\{!closing\}>/);
    expect(source).toMatch(/closeAfterFrame\(\(\) =>\s*leavePlayer\(router/);
    expect(source).toMatch(/closeAfterFrame\(\(\) => router\.replace\(href\)\)/);
    expect(source).not.toMatch(/^\s*leavePlayer\(router/m);
  });
});
