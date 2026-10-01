/** True when test playback must stay silent (dev builds started with EXPO_PUBLIC_TEST_MUTED=1). */
export function resolveTestMuted(flag: string | undefined, dev: boolean): boolean {
  return dev && (flag === '1' || flag === 'true');
}

export const TEST_MUTED = resolveTestMuted(
  process.env.EXPO_PUBLIC_TEST_MUTED,
  typeof __DEV__ !== 'undefined' && __DEV__
);

/** The muted state an engine applies: a test-muted build ignores unmute requests. */
export function effectiveMuted(requested: boolean, testMuted: boolean = TEST_MUTED): boolean {
  return testMuted || requested;
}
