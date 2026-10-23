import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { afterPaint, useMountStage } from '../use-mount-stage';

// A hand-driven frame clock: `frame()` runs the callbacks queued for the next frame.
let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
const realRaf = global.requestAnimationFrame;
const realCancel = global.cancelAnimationFrame;
beforeEach(() => {
  queue = new Map();
  global.requestAnimationFrame = (callback) => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  };
  global.cancelAnimationFrame = (id?: number | null) => void queue.delete(id ?? 0);
});
afterEach(() => {
  global.requestAnimationFrame = realRaf;
  global.cancelAnimationFrame = realCancel;
});
const frame = () => {
  const due = [...queue.values()];
  queue.clear();
  for (const callback of due) callback(0);
};

function Stages({ last }: { last: number }) {
  const stage = useMountStage(last);
  return (
    <>
      <Text testID="stage">{String(stage)}</Text>
      {stage >= 1 ? <Text testID="heavy">heavy</Text> : null}
    </>
  );
}

it('renders the light first frame, then one stage per painted frame up to the last', async () => {
  await render(<Stages last={2} />);
  expect(screen.getByTestId('stage')).toHaveTextContent('0');
  expect(screen.queryByTestId('heavy')).toBeNull();
  // One frame is not enough: the first frame must have been painted (two animation frames).
  await act(async () => frame());
  expect(screen.getByTestId('stage')).toHaveTextContent('0');
  await act(async () => frame());
  expect(screen.getByTestId('stage')).toHaveTextContent('1');
  expect(screen.getByTestId('heavy')).toBeTruthy();
  await act(async () => frame());
  await act(async () => frame());
  expect(screen.getByTestId('stage')).toHaveTextContent('2');
  await act(async () => frame());
  // The last stage schedules no more frames.
  expect(queue.size).toBe(0);
});

it('an unmounted screen leaves no frame callback behind', async () => {
  await render(<Stages last={3} />);
  expect(queue.size).toBe(1);
  await screen.unmount();
  expect(queue.size).toBe(0);
});

it('afterPaint waits two frames and can be cancelled', () => {
  const then = jest.fn();
  afterPaint(then);
  frame();
  expect(then).not.toHaveBeenCalled();
  frame();
  expect(then).toHaveBeenCalledTimes(1);
  const other = jest.fn();
  const cancel = afterPaint(other);
  frame();
  cancel();
  frame();
  frame();
  expect(other).not.toHaveBeenCalled();
});
