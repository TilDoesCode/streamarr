import { MAX_ATTEMPTS, MAX_STEP_DOWNS } from '@/player/recovery/budgets';
import { cardActions, Incident, nextStep, type LadderContext } from '@/player/recovery/ladder';

const attached: LadderContext = {
  attached: true,
  online: true,
  canLowerQuality: false,
  revision: 0,
  audioFallback: false,
};

function run(
  incident: Incident,
  category: Parameters<typeof nextStep>[1]['category'],
  code: string,
  revision = 0
) {
  const decision = nextStep(incident, { category, code }, { ...attached, revision });
  if (decision.step !== 'G' && decision.step !== 'W')
    incident.record({ step: decision.step, category, code, position: 0, at: 0, revision });
  return decision.step;
}

describe('ladder budgets and card actions (review M13, P2)', () => {
  it.each([
    ['T1', 'network_unreachable', ['retry']],
    ['T1', 'tls_error', []],
    ['T2', 'unknown_transcode', ['retry']],
    ['T3', 'refresh_session_expired', ['signIn']],
    ['T4', 'transcode_capacity', ['retry']],
    ['T5', 'playback_stalled', ['lowerQuality', 'otherVersion']],
    ['T6', 'transcode_failed', ['retry', 'otherVersion']],
    ['T7', 'decode_error', ['otherVersion', 'useVlc']],
    ['T8', 'end_of_stream', ['otherVersion']],
    ['T9', 'age_restricted', []],
    ['T11', 'player_internal_error', ['retry']],
    ['T11', 'invalid_playback_request', []],
  ] as const)('%s %s offers %j', (category, code, actions) => {
    expect(cardActions(category, code)).toEqual(actions);
  });

  it("puts the server's suggestions first", () => {
    expect(cardActions('T7', 'no_more_methods', ['otherVersion', 'retry'])).toEqual([
      'otherVersion',
      'retry',
      'useVlc',
    ]);
  });

  it('steps down at most three times per incident, one per revision of picture failures; then another version, then the card (S4z3)', () => {
    const incident = new Incident(0);
    const steps = [0, 1, 2, 3, 4].map((revision) => {
      run(incident, 'T7', 'decode_error', revision);
      return run(incident, 'T7', 'decode_error', revision);
    });
    expect(steps).toEqual(['S', 'S', 'S', 'V', 'G']);
    expect(MAX_STEP_DOWNS).toBe(3);
  });

  it('every incident ends after twelve steps whatever the categories', () => {
    expect(MAX_ATTEMPTS).toBe(12);
  });

  it('a content failure tries the reload, then another version once, then the card', () => {
    const incident = new Incident(0);
    expect([1, 2, 3].map(() => run(incident, 'T8', 'end_of_stream'))).toEqual(['R', 'V', 'G']);
  });

  it('no method of the version plays (a failed playback): another version, then the card', () => {
    const incident = new Incident(0);
    const detached = { ...attached, attached: false };
    expect(nextStep(incident, { category: 'T7', code: 'no_more_methods' }, detached).step).toBe(
      'V'
    );
    incident.record({
      step: 'V',
      category: 'T7',
      code: 'no_more_methods',
      position: 0,
      at: 0,
      revision: 0,
    });
    expect(nextStep(incident, { category: 'T7', code: 'no_more_methods' }, detached).step).toBe(
      'G'
    );
  });
});
