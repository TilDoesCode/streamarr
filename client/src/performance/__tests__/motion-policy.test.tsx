import { render, screen } from '@testing-library/react-native';

import { MotionConfig } from '../motion-config';
import { motionPolicy, systemAnimationsOff } from '../motion-policy';

describe('motion policy', () => {
  const full = motionPolicy(false, false);
  const lite = motionPolicy(true, false);

  it('lite keeps cheap motion: timed focus lift, ring fade, press feedback, row scrolling, overlays', () => {
    expect(lite).toMatchObject({
      focusLift: 'timing',
      pressFeedback: true,
      rowScroll: true,
      reduceAll: false,
      heroRestMs: 400,
      heroCrossfadeMs: 250,
    });
    expect(lite.maxLift).toBeGreaterThan(1);
    expect(lite.maxLift).toBeLessThanOrEqual(1.06);
  });

  it('lite drops the expensive effects: glow, ambient backdrop, skeleton pulse, image fade-ins', () => {
    expect(lite).toMatchObject({
      focusGlow: false,
      ambientBackdrop: false,
      skeletonPulse: false,
      imageFadeIn: false,
      ringInstantOut: true,
    });
  });

  it('the full UI keeps every effect and the spring', () => {
    expect(full).toMatchObject({
      focusLift: 'spring',
      focusGlow: true,
      ambientBackdrop: true,
      skeletonPulse: true,
      imageFadeIn: true,
      ringInstantOut: false,
      rowScroll: true,
      reduceAll: false,
      heroRestMs: 150,
    });
    expect(full.maxLift).toBe(Infinity);
  });

  it('system animations off reduce everything, lite or not', () => {
    for (const policy of [motionPolicy(false, true), motionPolicy(true, true)])
      expect(policy).toMatchObject({
        focusLift: 'none',
        pressFeedback: false,
        skeletonPulse: false,
        imageFadeIn: false,
        rowScroll: false,
        heroCrossfadeMs: 0,
        reduceAll: true,
      });
  });
});

describe('MotionConfig', () => {
  it('leaves Reanimated alone while the system animations run (lite mode included)', async () => {
    expect(systemAnimationsOff).toBe(false);
    await render(<MotionConfig />);
    expect(screen.toJSON()).toBeNull();
  });
});
