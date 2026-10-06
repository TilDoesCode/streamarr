import { harness } from '@/../jest/player/harness';
import { playing } from '@/../jest/player/play';
import i18n from '@/i18n';
import { noticeText } from '@/player/overlay-labels';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

beforeEach(() => harness.reset());

describe('one playing tab per browser: the player side (F12)', () => {
  it('the controller pauses and says why, in de and en; a paused player stays as it is', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 30);
    c.yieldToOtherTab();
    expect(c.paused).toBe(true);
    expect(harness.engine.pause).toHaveBeenCalled();
    expect(c.notice).toMatchObject({ kind: 'otherTab' });
    for (const [lang, text] of [
      ['de', /^Wiedergabe in einem anderen Tab gestartet/],
      ['en', /^Playback started in another tab/],
    ] as const) {
      await i18n.changeLanguage(lang);
      const pt = (key: string, options?: Record<string, unknown>) =>
        i18n.t(key as never, { ...options, ns: 'player' } as never) as unknown as string;
      expect(
        noticeText(
          c.notice!,
          pt as never,
          () => '',
          () => ''
        )
      ).toMatch(text);
    }
    c.dismissNotice();
    c.yieldToOtherTab();
    expect(c.notice).toBeNull();
    await c.stop();
    jest.useRealTimers();
  });
});
