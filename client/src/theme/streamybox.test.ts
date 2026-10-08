/* eslint-disable @typescript-eslint/no-require-imports -- tokens load in isolation with a mocked host */
import palette from './colors.json';
import radiusTokens from './radius.json';
import {
  STREAMYBOX_COLORS,
  STREAMYBOX_EASING,
  STREAMYBOX_FONTS,
  STREAMYBOX_MOTION,
  STREAMYBOX_RADIUS,
  STREAMYBOX_SPRINGS,
  STREAMYBOX_TV_FOCUS,
  STREAMYBOX_TV_TYPE,
} from './streamybox';
import * as tokens from './tokens';

type Tokens = typeof tokens;

function leaves(value: unknown, path = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      for (const [p, v] of leaves(child, path ? `${path}.${key}` : key)) out.set(p, v);
  } else out.set(path, value);
  return out;
}

function changed(a: unknown, b: unknown): string[] {
  const left = leaves(a);
  const right = leaves(b);
  expect([...left.keys()].filter((k) => !right.has(k))).toEqual([]);
  return [...right.keys()].filter(
    (k) => JSON.stringify(left.get(k)) !== JSON.stringify(right.get(k))
  );
}

function loadStreamybox(): Tokens {
  let loaded: Tokens | undefined;
  jest.isolateModules(() => {
    jest.doMock('@modules/host-system', () => ({ hostTheme: 'streamybox' }));
    loaded = require('./tokens');
  });
  return loaded!;
}

const tokenSet = (t: Tokens) => ({
  colors: t.colors,
  radius: t.radius,
  fonts: t.fonts,
  typeRamp: t.typeRamp,
  focusTokens: t.focusTokens,
  motion: t.motion,
  springs: t.springs,
  easing: t.easing,
  layouts: t.layouts,
  space: t.space,
  aspect: t.aspect,
});

describe('default theme', () => {
  it('is the plain host outside Streamybox and keeps every token as before', () => {
    expect(tokens.theme).toBe('default');
    expect(tokens.colors).toBe(palette);
    expect(tokens.radius).toBe(radiusTokens.radius);
    expect(tokens.fonts).toEqual({
      displayBold: 'Outfit-Bold',
      display: 'Outfit-SemiBold',
      body: 'Figtree-Regular',
      bodyMedium: 'Figtree-Medium',
      bodySemiBold: 'Figtree-SemiBold',
      bodyBold: 'Figtree-Bold',
      mono: 'JetBrainsMono-Medium',
    });
    expect(tokens.typeRamp.tv.display).toEqual({
      fontSize: 44,
      lineHeight: 46,
      letterSpacing: -1.1,
      fontFamily: 'Outfit-Bold',
    });
    expect(tokens.typeRamp.tv.spec).toEqual({
      fontSize: 9.5,
      lineHeight: 12,
      letterSpacing: 0.4,
      fontFamily: 'JetBrainsMono-Medium',
    });
    expect(tokens.focusTokens.tv).toEqual({
      cardScale: 1.1,
      buttonScale: 1.06,
      pressedScale: 0.97,
      ringWidth: 3,
      ringOffset: 3,
      air: 8,
      buttonExtent: 160,
    });
    expect(tokens.motion).toMatchObject({ press: 120, focus: 160, enter: 280, exit: 180 });
    expect(tokens.motion.panelRise).toBe(24);
    expect(tokens.springs).toEqual({
      focus: { damping: 18, stiffness: 180, mass: 1 },
      press: { damping: 22, stiffness: 320, mass: 1 },
    });
    expect(tokens.easing).toEqual({ out: [0.23, 1, 0.32, 1], sheet: [0.32, 0.72, 0, 1] });
  });
});

describe('Streamybox theme', () => {
  const sb = loadStreamybox();

  it('is selected by the host module', () => {
    expect(sb.theme).toBe('streamybox');
  });

  it('replaces exactly the overridden colours and keeps their format', () => {
    const diff = changed(tokens.colors, sb.colors);
    expect(diff.sort()).toEqual([...leaves(STREAMYBOX_COLORS).keys()].sort());
    const before = leaves(tokens.colors);
    for (const [path, value] of leaves(sb.colors)) {
      const hex = /^#[0-9A-F]{6}$/i;
      expect([path, hex.test(String(value))]).toEqual([path, hex.test(String(before.get(path)))]);
    }
  });

  it('keeps semantic, avatar and QR colours', () => {
    for (const key of [
      'success',
      'warning',
      'danger',
      'destructive',
      'avatar',
      'qr',
      'video',
    ] as const)
      expect(sb.colors[key]).toEqual(tokens.colors[key]);
  });

  it('changes only fonts, TV type, radii, TV focus and motion; layout stays', () => {
    const before = tokenSet(tokens);
    const after = tokenSet(sb);
    const diff = changed(before, after);
    const expected = [
      ...[...leaves(STREAMYBOX_COLORS).keys()].map((k) => `colors.${k}`),
      ...Object.keys(STREAMYBOX_RADIUS).map((k) => `radius.${k}`),
      ...Object.keys(STREAMYBOX_FONTS).map((k) => `fonts.${k}`),
      ...Object.keys(STREAMYBOX_TV_FOCUS).map((k) => `focusTokens.tv.${k}`),
      ...Object.keys(STREAMYBOX_MOTION).map((k) => `motion.${k}`),
      ...[...leaves(STREAMYBOX_SPRINGS).keys()].map((k) => `springs.${k}`),
      ...Object.keys(STREAMYBOX_EASING).map((k) => `easing.${k}`),
    ];
    const outside = diff.filter((k) => !k.startsWith('typeRamp.'));
    expect(outside.sort()).toEqual(expected.sort());
    expect(diff.some((k) => k.startsWith('layouts.') || k.startsWith('space.'))).toBe(false);
  });

  it('uses Inter on every form factor and the Streamybox TV scale', () => {
    for (const ramp of Object.values(sb.typeRamp))
      for (const step of Object.values(ramp)) expect(step.fontFamily).toMatch(/^Inter-/);
    for (const [variant, [fontSize, lineHeight, letterSpacing]] of Object.entries(
      STREAMYBOX_TV_TYPE
    ))
      expect(sb.typeRamp.tv[variant as keyof typeof STREAMYBOX_TV_TYPE]).toMatchObject({
        fontSize,
        lineHeight,
        letterSpacing,
      });
    expect(sb.typeRamp.phone.body.fontSize).toBe(tokens.typeRamp.phone.body.fontSize);
  });

  it('focus spring never overshoots', () => {
    const { damping, stiffness, mass } = sb.springs.focus;
    expect(damping).toBeGreaterThanOrEqual(2 * Math.sqrt(stiffness * mass));
  });
});
