import { describe, expect, it } from "vitest";
import { ageLimitLabel, episodeWorkId, extractCodes, formatClock, initials, parseWorkId, permissionsSummary, randomId } from "./viewers";

describe("viewer helpers", () => {
  it("labels age limits", () => {
    expect(ageLimitLabel(null)).toBe("Unrestricted");
    expect(ageLimitLabel(0)).toBe("All ages (0)");
    expect(ageLimitLabel(16)).toBe("16+");
  });

  it("summarizes non-default permissions", () => {
    expect(permissionsSummary({ blockUnrated: true, allowTranscoding: false, maxConcurrentStreams: 1 })).toEqual([
      "blocks unrated",
      "no transcoding",
      "max 1 stream",
    ]);
    expect(permissionsSummary({ allowTranscoding: true })).toEqual([]);
  });

  it("parses canonical work ids", () => {
    expect(parseWorkId("tmdb-movie-603")).toEqual({ kind: "movie", tmdbId: 603 });
    expect(parseWorkId("tmdb-tv-1396-s01e05")).toEqual({ kind: "episode", tmdbId: 1396, season: 1, episode: 5 });
    expect(parseWorkId("tmdb-tv-1396-s02")).toEqual({ kind: "season", tmdbId: 1396, season: 2 });
    expect(parseWorkId("tmdb-tv-1396")).toEqual({ kind: "series", tmdbId: 1396 });
    expect(parseWorkId("tmdb-tv-1396-s1e1")).toBeNull();
    expect(parseWorkId("tmdb-movie-603-s01")).toBeNull();
    expect(parseWorkId("imdb-tt0133093")).toBeNull();
  });

  it("builds zero-padded episode ids", () => {
    expect(episodeWorkId(1396, 1, 1)).toBe("tmdb-tv-1396-s01e01");
    expect(episodeWorkId(66732, 4, 12)).toBe("tmdb-tv-66732-s04e12");
  });

  it("extracts sign-in and reset codes from mail text", () => {
    expect(extractCodes("Your code: AB12-CD34\nIt expires soon. AB12-CD34 again, abcd-efgh no")).toEqual(["AB12-CD34"]);
    expect(extractCodes(null)).toEqual([]);
  });

  it("formats clock times and random ids", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("initials", () => {
  it("uses letters only and falls back gracefully", () => {
    expect(initials("Ben (12)")).toBe("BE");
    expect(initials("Guest TV")).toBe("GT");
    expect(initials("guest.tv")).toBe("GT");
    expect(initials("Élodie")).toBe("ÉL");
    expect(initials("42")).toBe("42");
    expect(initials("")).toBe("?");
  });
});
