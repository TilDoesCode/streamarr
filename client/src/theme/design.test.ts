import { createDesign } from './design';
import { detectFormFactor, tvScale, type FormFactorInput } from './form-factor';
import { layouts, typeRamp } from './tokens';

const base: FormFactorInput = {
  os: 'android',
  isTV: false,
  isPad: false,
  width: 412,
  height: 915,
  finePointer: false,
};

describe('detectFormFactor', () => {
  it.each<[string, Partial<FormFactorInput>, string]>([
    ['Google TV (960 dp canvas)', { isTV: true, width: 960, height: 540 }, 'tv'],
    ['Apple TV', { os: 'ios', isTV: true, width: 1920, height: 1080 }, 'tv'],
    ['Android phone', {}, 'phone'],
    ['Android phone landscape', { width: 915, height: 412 }, 'phone'],
    ['Android tablet', { width: 800, height: 1280 }, 'tablet'],
    ['iPhone', { os: 'ios', width: 393, height: 852 }, 'phone'],
    ['iPad', { os: 'ios', isPad: true, width: 820, height: 1180 }, 'tablet'],
    ['iPad slide over', { os: 'ios', isPad: true, width: 320, height: 1180 }, 'phone'],
    ['desktop browser', { os: 'web', width: 1440, height: 900, finePointer: true }, 'desktop-web'],
    ['narrow desktop browser', { os: 'web', width: 500, height: 900, finePointer: true }, 'phone'],
    ['iPad Safari', { os: 'web', width: 1024, height: 1366, finePointer: false }, 'tablet'],
    ['phone browser', { os: 'web', width: 390, height: 844 }, 'phone'],
  ])('%s → %s', (_, input, expected) => {
    expect(detectFormFactor({ ...base, ...input })).toBe(expected);
  });
});

describe('createDesign', () => {
  it('scales the 10-foot ramp with the TV canvas (Android TV 1×, tvOS 2×)', () => {
    expect(tvScale(960)).toBe(1);
    expect(tvScale(1920)).toBe(2);
    const androidTv = createDesign('tv', 960, 540);
    const appleTv = createDesign('tv', 1920, 1080);
    expect(androidTv.type.body.fontSize).toBe(typeRamp.tv.body.fontSize);
    expect(appleTv.type.body.fontSize).toBe(typeRamp.tv.body.fontSize * 2);
    expect(appleTv.layout.gutter).toBe(layouts.tv.gutter * 2);
    expect(appleTv.layout.controlHeight.md).toBe(layouts.tv.controlHeight.md * 2);
    expect(appleTv.space.lg).toBe(32);
    expect(appleTv.focus.ringWidth).toBe(6);
  });

  it('never scales handheld layouts and keeps capsules round', () => {
    const phone = createDesign('phone', 2000, 3000);
    expect(phone.scale).toBe(1);
    expect(phone.layout.gutter).toBe(layouts.phone.gutter);
    expect(phone.radius.full).toBe(9999);
  });

  it('uses a larger ramp and wider gutters away from phones', () => {
    const phone = createDesign('phone', 390, 844);
    const desktop = createDesign('desktop-web', 1440, 900);
    expect(desktop.type.display.fontSize).toBeGreaterThan(phone.type.display.fontSize);
    expect(desktop.layout.gutter).toBeGreaterThan(phone.layout.gutter);
    expect(phone.focus.cardScale).toBe(1);
    expect(createDesign('tv', 960, 540).focus.cardScale).toBeGreaterThan(1);
  });
});
