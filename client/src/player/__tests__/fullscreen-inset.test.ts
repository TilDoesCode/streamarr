import { safariFullscreenInset } from '../fullscreen.web';

const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const CHROME_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

describe('safariFullscreenInset', () => {
  it('clears the Safari close button in full screen on iPad and iPhone', () => {
    expect(safariFullscreenInset(true, IPAD, 5)).toBe(44);
    expect(safariFullscreenInset(true, IPHONE, 5)).toBe(44);
  });

  it('is 0 outside full screen, on desktop Safari and other browsers', () => {
    expect(safariFullscreenInset(false, IPAD, 5)).toBe(0);
    expect(safariFullscreenInset(true, IPAD, 0)).toBe(0);
    expect(safariFullscreenInset(true, CHROME_DESKTOP, 0)).toBe(0);
  });
});
