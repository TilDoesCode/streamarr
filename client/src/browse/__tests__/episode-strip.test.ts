import { EPISODE_CARD, MOVE_KEYS, rovingTabStop, stripOffset } from '../episode-strip';

const episodes = [1, 2, 3].map((episodeNumber) => ({ episodeNumber }));

describe('episode strip keyboard (web)', () => {
  it('keeps one Tab stop: focused card, else the marked one, else the first', () => {
    expect(rovingTabStop(episodes, 3, 2)).toBe(3);
    expect(rovingTabStop(episodes, null, 2)).toBe(2);
    expect(rovingTabStop(episodes, 9, undefined)).toBe(1);
    expect(rovingTabStop([], null, undefined)).toBeUndefined();
  });

  it('moves with the arrow keys, Home and End only', () => {
    expect(MOVE_KEYS).toEqual({ ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' });
    expect(MOVE_KEYS.Enter).toBeUndefined();
  });
});

describe('episode strip on TV (long seasons)', () => {
  // 1920 × 1080 points: gutter 168, card 352 + gap 32 → the second position is x = 552.
  const gutter = 168;
  const stride = EPISODE_CARD.width + 32;
  const cardX = (index: number) => gutter + index * stride - stripOffset(index, gutter, stride);

  it('keeps the focused card at the second position from the second card on (24 episodes)', () => {
    expect(cardX(0)).toBe(168);
    for (let index = 1; index < 24; index += 1) expect(cardX(index)).toBe(552);
  });

  it('never scrolls before the start', () => {
    expect(stripOffset(0, gutter, stride)).toBe(0);
    expect(stripOffset(1, gutter, stride)).toBe(0);
    expect(stripOffset(11, gutter, stride)).toBe(10 * stride);
  });
});
