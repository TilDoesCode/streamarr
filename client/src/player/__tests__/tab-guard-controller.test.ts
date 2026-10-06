import { harness, newController, reply } from '@/../jest/player/harness';
import { playing, settle } from '@/../jest/player/play';
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

  it('the newest start wins: a tab still starting when another tab starts comes up paused with the notice, it never pauses the newer tab (verify P1)', async () => {
    jest.useFakeTimers();
    let release: (value: ReturnType<typeof reply.ok>) => void = () => undefined;
    harness.server.answer('start', () => new Promise((resolve) => (release = resolve)));
    const c = newController();
    const started = c.start();
    await settle();
    expect(c.phase).toBe('starting');
    c.yieldToOtherTab();
    release(reply.ok(harness.server.playback()));
    await started;
    harness.engine.started();
    await settle();
    expect(c.phase).toBe('playing');
    expect(c.paused).toBe(true);
    expect(harness.engine.commands.at(-1)).toBe('pause');
    expect(c.notice).toMatchObject({ kind: 'otherTab' });
    await c.stop();
    jest.useRealTimers();
  });

  it('a stopped or failed player ignores another tab', async () => {
    jest.useFakeTimers();
    const c = await playing({}, {}, 30);
    await c.stop();
    c.yieldToOtherTab();
    expect(c.notice).toBeNull();
    jest.useRealTimers();
  });
});
