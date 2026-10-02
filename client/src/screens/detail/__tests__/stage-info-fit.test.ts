import { SHELL } from '@/shell/shell-metrics';
import { createDesign } from '@/theme/design';

import {
  liftedTop,
  MOVIE_INFO_MAX_CUT,
  movieInfoPlan,
  nextInfoCut,
  SERIES_INFO_MAX_CUT,
  seriesInfoPlan,
} from '../stage-info-fit';

// Apple TV 4K at 1080p: 1920 × 1080 points, the Bühne in shell points 1:1.
const { focus } = createDesign('tv', 1920, 1080);
const limit = SHELL.tvosTabBarBottom;
const line = { title: 22, overview: 29, row: 26, more: 26 };
const gap = 12;
const padding = 2 * 28;

/** Height of "About the series" for a plan (the StageInfo layout: title, rows, link, 12 pt gaps). */
function seriesHeight(plan: ReturnType<typeof seriesInfoPlan>) {
  const rows = [
    line.overview * plan.overviewLines,
    plan.facts ? line.row : 0,
    plan.genres ? line.row : 0,
    plan.rating ? line.row : 0,
    line.row,
  ].filter(Boolean);
  return (
    padding +
    line.title +
    rows.reduce((sum, row) => sum + row, 0) +
    line.more +
    gap * (rows.length + 1)
  );
}

/** Runs the layout loop: measure, cut one step while the lifted column crosses the limit. */
function settle(bottom: number, height: (cut: number) => number, maxCut: number) {
  let cut = 0;
  for (let pass = 0; pass <= maxCut; pass += 1) {
    const next = nextInfoCut(
      cut,
      liftedTop(bottom - height(cut), height(cut), focus, focus.cardScale),
      limit,
      maxCut
    );
    if (next === cut) break;
    cut = next;
  }
  return { cut, lifted: liftedTop(bottom - height(cut), height(cut), focus, focus.cardScale) };
}

describe('Bühne info column below the Apple TV tab bar', () => {
  it('Sherlock (4-line overview + all rows) ends with its lifted ring below the tab bar', () => {
    // Measured in round 1: the column sat at y 128, 398 pt high (bottom 526), its ring reached the bar.
    const height = (cut: number) => seriesHeight(seriesInfoPlan(cut));
    expect(height(0)).toBeGreaterThanOrEqual(390);
    expect(liftedTop(526 - height(0), height(0), focus, focus.cardScale)).toBeLessThan(limit);
    const { cut, lifted } = settle(526, height, SERIES_INFO_MAX_CUT);
    expect(cut).toBeGreaterThan(0);
    expect(lifted).toBeGreaterThanOrEqual(limit);
    // Progress and the "More about the series" link always stay.
    expect(seriesInfoPlan(SERIES_INFO_MAX_CUT)).toEqual({
      overviewLines: 1,
      genres: false,
      rating: false,
      facts: false,
    });
  });

  it('keeps the full column when it fits and cuts in order on a taller stage', () => {
    const height = (cut: number) => seriesHeight(seriesInfoPlan(cut));
    expect(settle(900, height, SERIES_INFO_MAX_CUT).cut).toBe(0);
    const tight = settle(440, height, SERIES_INFO_MAX_CUT);
    expect(tight.cut).toBeGreaterThanOrEqual(4);
    expect(tight.lifted).toBeGreaterThanOrEqual(limit);
    expect(seriesInfoPlan(3)).toEqual({
      overviewLines: 1,
      genres: true,
      rating: true,
      facts: true,
    });
  });

  it('movie Details: the round-1 column (y 674, 170 pt) stays whole; a cramped one drops lines, rating, credits', () => {
    const height = (cut: number) => {
      const plan = movieInfoPlan(cut);
      const credits = plan.credits * line.row * plan.creditLines;
      return padding + line.title + credits + (plan.rating ? line.row : 0) + line.more + gap * 4;
    };
    expect(settle(844, height, MOVIE_INFO_MAX_CUT).cut).toBe(0);
    const cramped = settle(400, height, MOVIE_INFO_MAX_CUT);
    expect(cramped.cut).toBeGreaterThan(0);
    expect(cramped.lifted).toBeGreaterThanOrEqual(limit);
    expect(movieInfoPlan(MOVIE_INFO_MAX_CUT)).toEqual({
      creditLines: 1,
      rating: false,
      credits: 1,
    });
  });
});
