import { categoryOf } from '@/api/error-categories';
import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { pending, row } from '@/../jest/player/matrix';

const generic = () => describeError(i18n.t, { code: 'unknown' });

// State matrix layer A (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix A — App, auth, device and OS', () => {
  pending('A01', 'Access token expires mid-play', 'regression test, S3+');
  pending('A02', 'Refresh fails transiently (offline, 5xx, timeout) mid-play', 'S4');
  pending('A03', 'Refresh refused: refresh_session_expired', 'S4');
  row('A04', 'refresh refused with revoked/unknown session codes is never the generic text', () => {
    for (const code of ['refresh_session_revoked', 'refresh_token_unknown']) {
      expect(categoryOf(code)).toBe('T3');
      const text = describeError(i18n.t, {
        code,
        params: { reason: 'session_limit' },
        status: 401,
      });
      expect(text.title).not.toBe(generic().title);
      expect(text.title).not.toMatch(/errors\./);
    }
  });
  pending(
    'A04',
    'player card H.signedOut names the reason; F8 adds the code texts',
    'S4 + F8 merge'
  );
  pending('A05', 'Refresh refused: refresh_token_reused', 'S4');
  row(
    'A06',
    'account disabled mid-play: the refused refresh reads as signed out, not generic',
    () => {
      const code = 'refresh_session_revoked';
      expect(categoryOf(code, 401)).toBe('T3');
      expect(describeError(i18n.t, { code, params: { reason: 'account_disabled' } })).toEqual(
        expect.objectContaining({ title: expect.not.stringMatching(generic().title) })
      );
      expect(describeError(i18n.t, { code: 'account_disabled' }).title).not.toBe(generic().title);
    }
  );
  pending('A06', 'player pauses, keeps the position, card H.signedOut "Account disabled"', 'S4');
  pending('A07', 'password_change_required (403) mid-play', 'S4');
  pending('A08', 'App backgrounded, no PiP (TV, web tab, VLC, paused)', 'regression test, S3+');
  pending('A09', 'Backgrounded > 600 s (iOS/tvOS suspend JS timers: no heartbeats)', 'S4');
  pending('A10', 'Backgrounded with PiP (phones, expo-video)', 'regression test, S3+');
  pending('A11', 'OS kills the app (background or memory)', 'regression test, S3+');
  pending('A12', 'Device lock / sleep while playing (phone, no PiP)', 'S6');
  pending('A13', 'Audio focus lost (phone call, Siri, alarm, other app plays audio)', 'S6');
  pending('A14', 'Headphones / Bluetooth disconnected ("becoming noisy")', 'S6');
  pending('A15', 'PiP start / stop via button or leaving the app', 'regression test, S3+');
  pending('A16', 'PiP window closed by the viewer (✕)', 'S6');
  pending('A17', 'Failure while in PiP', 'S4');
  pending('A18', 'AirPlay start (iPhone/iPad)', 'S6');
  pending('A19', 'AirPlay receiver lost / turned off', 'S6');
  pending('A20', 'Chromecast / Remote Playback API', 'regression test, S3+');
  pending('A21', 'Low memory while playing (iOS memory warning, Android onTrimMemory)', 'S4');
  pending('A22', 'Rotation (phone)', 'regression test, S3+');
  pending('A23', 'Network change Wi-Fi ↔ cellular (LAN-only server URL)', 'S4');
  pending('A24', 'Offline mid-play', 'S4');
  pending('A25', 'Back online after a failure', 'S4');
  pending('A26', 'Captive portal / proxy answers HTML', 'S4');
  pending('A27', 'Device clock skew', 'regression test, S3+');
  pending('A28', 'TLS failure mid-play (certificate rotated)', 'S4');
});
