import { act } from '@testing-library/react-native';
import { Platform } from 'react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { BackControl, isWebBackKey, stageBackLayout } from './back-control';

const mockRouter = { back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
let mockFocused = true;
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useIsFocused: () => mockFocused,
}));

const key = (init: Record<string, unknown>) =>
  ({
    key: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    ...init,
  }) as Parameters<typeof isWebBackKey>[0];

describe('stageBackLayout (Q1-17)', () => {
  it('web 1920 × 1080: the series stage keeps its TV top, the logo row moves beside the control', () => {
    expect(
      stageBackLayout({ stageTop: 64, minTop: 64, frameTop: 48, clearance: 144, indent: 96 })
    ).toEqual({ paddingTop: 64, indent: 96 });
  });

  it('TV (no control): unchanged', () => {
    expect(
      stageBackLayout({ stageTop: 64, minTop: 64, frameTop: 0, clearance: 0, indent: 0 })
    ).toEqual({ paddingTop: 64, indent: 0 });
  });

  it('tall windows (stage top below the control): below the control, no indent', () => {
    expect(
      stageBackLayout({ stageTop: 400, minTop: 45, frameTop: 34, clearance: 101, indent: 60 })
    ).toEqual({ paddingTop: 101, indent: 0 });
  });
});

describe('web back keys', () => {
  it('Escape and Alt+Left go back; text fields, open dialogs and modifiers do not', () => {
    expect(isWebBackKey(key({ key: 'Escape' }), false)).toBe(true);
    expect(isWebBackKey(key({ key: 'ArrowLeft', altKey: true }), false)).toBe(true);
    expect(isWebBackKey(key({ key: 'ArrowLeft' }), false)).toBe(false);
    expect(isWebBackKey(key({ key: 'Escape' }), true)).toBe(false);
    expect(isWebBackKey(key({ key: 'Escape', target: { tagName: 'INPUT' } }), false)).toBe(false);
    expect(isWebBackKey(key({ key: 'Escape', metaKey: true }), false)).toBe(false);
    expect(isWebBackKey(key({ key: 'Escape', defaultPrevented: true }), false)).toBe(false);
  });

  describe('BackControl on web', () => {
    const os = Platform.OS;
    let doc: EventTarget & { querySelector: jest.Mock };
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
      doc = Object.assign(new EventTarget(), { querySelector: jest.fn(() => null) });
      (global as { document?: unknown }).document = doc;
      mockRouter.back.mockClear();
      mockFocused = true;
    });
    afterEach(() => {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
      delete (global as { document?: unknown }).document;
    });
    const press = (init: Record<string, unknown>) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), init);
      act(() => void doc.dispatchEvent(event));
      return event;
    };

    it('Escape and Alt+Left trigger the back action once, not while a dialog is open', async () => {
      await renderWithProviders(<BackControl />);
      expect(press({ key: 'Escape' }).defaultPrevented).toBe(true);
      press({ key: 'ArrowLeft', altKey: true });
      expect(mockRouter.back).toHaveBeenCalledTimes(2);
      doc.querySelector.mockReturnValue({});
      press({ key: 'Escape' });
      expect(mockRouter.back).toHaveBeenCalledTimes(2);
    });

    it('a screen under the focused one ignores the keys', async () => {
      mockFocused = false;
      await renderWithProviders(<BackControl />);
      press({ key: 'Escape' });
      expect(mockRouter.back).not.toHaveBeenCalled();
    });
  });
});
