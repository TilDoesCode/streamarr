import { Keyframe } from 'react-native-reanimated';

import { webSlide } from '../sheet';

jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { ...actual, Keyframe: jest.fn(() => ({ duration: () => ({}) })) };
});

describe('web sheet slide (Q1-01)', () => {
  it('builds no custom Keyframe: Reanimated web pins a Keyframe element to its first measured box', () => {
    (Keyframe as unknown as jest.Mock).mockClear();
    for (const side of [true, false]) {
      const { enter, exit } = webSlide(side);
      expect(enter).toBeDefined();
      expect(exit).toBeDefined();
    }
    expect(Keyframe).not.toHaveBeenCalled();
  });
});
