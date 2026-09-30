import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  AmbientProvider,
  useAmbientTitle,
  useClearAmbient,
  useSetAmbient,
} from './ambient-provider';

const wrapper = ({ children }: { children: ReactNode }) => (
  <AmbientProvider>{children}</AmbientProvider>
);

it('clears the ambient only while it still shows the caller title', async () => {
  const { result } = await renderHook(
    () => ({ title: useAmbientTitle(), set: useSetAmbient(), clear: useClearAmbient() }),
    { wrapper }
  );
  const home = { image: 'home.jpg' };
  const movies = { image: 'movies.jpg' };
  await act(() => result.current.set(home));
  await act(() => result.current.set(movies));
  // Home's blur runs after Movies painted the room: Movies keeps it.
  await act(() => result.current.clear(home));
  expect(result.current.title).toBe(movies);
  await act(() => result.current.clear(movies));
  expect(result.current.title).toBeNull();
});
