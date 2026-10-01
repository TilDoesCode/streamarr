import { windowControlsInset } from './window-controls';

describe('windowControlsInset', () => {
  const screen = { width: 1180, height: 820 };

  it('is 0 for a full-screen iPad app and off the iPad', () => {
    expect(windowControlsInset(true, screen, screen)).toBe(0);
    expect(windowControlsInset(false, { width: 750, height: 790 }, screen)).toBe(0);
  });

  it('clears the window controls in a resized iPadOS window', () => {
    expect(windowControlsInset(true, { width: 750, height: 790 }, screen)).toBe(30);
  });
});
