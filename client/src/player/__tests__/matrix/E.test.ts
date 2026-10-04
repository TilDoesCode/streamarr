import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { noticeError } from '@/player/overlay-labels';
import { harness, newController, reply } from '@/../jest/player/harness';
import { pending, row } from '@/../jest/player/matrix';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

const generic = () => describeError(i18n.t, { code: 'unknown' });

beforeEach(() => harness.reset());

// State matrix layer E (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix E — Player UI states', () => {
  pending(
    'E01',
    'Start stepper (queued → resolving → fallback → repairing → planning → starting)',
    'S3'
  );
  pending('E02', 'Stepper stage takes very long', 'S3');
  pending('E03', 'Between ready and the first frame', 'S3');
  pending('E04', 'Buffering mid-play', 'S3');
  pending('E05', 'Paused', 'S3');
  pending('E06', 'Paused by the system (A12–A14, A16, A19)', 'S3');
  pending('E07', 'Ended → up-next / end card / replay', 'S3');
  pending('E08', 'Closing', 'S3');
  pending('E09', 'Terminal failure card', 'S3');
  pending('E10', 'Failure while a side panel is open', 'S3');
  pending('E11', 'Failure / notice while the overlay is hidden', 'S3');
  pending('E12', 'Errors on TV', 'S3');
  pending('E13', 'Offline banner', 'S3');
  pending('E14', 'Step-down notice', 'S4');
  row(
    'E15',
    'switchFailed names the category of an unknown code, never the generic reason',
    async () => {
      await i18n.changeLanguage('en');
      const controller = newController();
      await controller.start();
      harness.engine.started();
      harness.server.answer('switch', reply.error(503, 'brand_new_code'));
      expect(await controller.setQuality(720)).toBe(false);
      expect(controller.phase).toBe('playing');
      expect(controller.notice).toMatchObject({
        kind: 'switchFailed',
        params: { code: 'brand_new_code', status: '503' },
      });
      const reason = describeError(i18n.t, noticeError(controller.notice!.params)).message;
      expect(reason).toBe(i18n.t('errors.categories.T4.message'));
      expect(reason).not.toBe(generic().message);
      expect(noticeError({ code: 'x', status: '0' }).status).toBe(0);
      await controller.stop();
    }
  );
  row('E16', 'device capabilities that fail to load get their own code and text', async () => {
    const screen = readFileSync(join(__dirname, '../../../screens/player/play-screen.tsx'), 'utf8');
    expect(screen).toContain("setCapsError('device_caps_unavailable')");
    for (const lng of ['en', 'de']) {
      await i18n.changeLanguage(lng);
      const text = describeError(i18n.t, { code: 'device_caps_unavailable' });
      expect(text).not.toEqual(generic());
    }
    await i18n.changeLanguage('en');
  });
  pending('E16', 'fall back to a conservative static profile and play', 'S3');
  pending('E17', 'Resume prompt left open for > 10 min', 'S4');
  pending('E18', '"Switching…" card (phase === \'switching\')', 'S4');
});
