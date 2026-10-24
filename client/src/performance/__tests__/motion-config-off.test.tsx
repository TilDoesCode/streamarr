import { render } from '@testing-library/react-native';

import { MotionConfig } from '../motion-config';
import { motionPolicy, systemAnimationsOff } from '../motion-policy';

// Developer options "Animator duration scale: off".
jest.mock('@modules/host-system', () => ({
  hostTheme: 'default',
  hostDevice: { animatorScale: 0 },
}));
const mockConfig = jest.fn((_props: { mode: string }) => null);
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  ReducedMotionConfig: (props: { mode: string }) => mockConfig(props),
  ReduceMotion: { Always: 'always' },
  useReducedMotion: () => false,
}));

describe('system animations off', () => {
  it('reduce every Reanimated animation, whatever the performance setting', async () => {
    expect(systemAnimationsOff).toBe(true);
    await render(<MotionConfig />);
    expect(mockConfig).toHaveBeenCalledWith({ mode: 'always' });
    expect(motionPolicy(true, systemAnimationsOff).focusLift).toBe('none');
  });
});
