import { selectGlassMode, type GlassEnvironment } from './glass-mode';

const base: GlassEnvironment = {
  os: 'ios',
  isTV: false,
  liquidGlass: true,
  reduceTransparency: false,
};

describe('selectGlassMode', () => {
  it.each<[string, Partial<GlassEnvironment>, string]>([
    ['iOS 26 with the glass API', {}, 'liquid'],
    ['tvOS 26', { isTV: true }, 'liquid'],
    ['iOS below 26', { liquidGlass: false }, 'blur'],
    ['tvOS below 26', { isTV: true, liquidGlass: false }, 'blur'],
    ['iOS 26 with Reduce Transparency', { reduceTransparency: true }, 'solid'],
    ['web', { os: 'web', liquidGlass: false }, 'css'],
    ['web with reduced transparency', { os: 'web', reduceTransparency: true }, 'solid'],
    ['Android phone', { os: 'android', liquidGlass: false }, 'translucent'],
    ['Android TV', { os: 'android', isTV: true, liquidGlass: false }, 'tinted'],
    ['Android TV never goes opaque by default', { os: 'android', isTV: true }, 'tinted'],
    ['Android never uses Liquid Glass', { os: 'android', liquidGlass: true }, 'translucent'],
    ['unknown platform', { os: 'windows' }, 'solid'],
  ])('%s → %s', (_, input, expected) => {
    expect(selectGlassMode({ ...base, ...input })).toBe(expected);
  });
});
