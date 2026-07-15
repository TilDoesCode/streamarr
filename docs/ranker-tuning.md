# Ranker & quality-profile tuning

The ranker is the "hidden Radarr" — the part people underestimate (BRIEF §7). A single
search returns dozens of releases: wrong resolutions, fakes, samples, password-
protected archives, incomplete or DMCA'd uploads. Parsing, rejecting, and ranking them
is the difference between *"feels like streaming"* and *"every third click fails."*

This guide explains the pipeline, every knob on a quality profile, the rejection
codes, how to read a score breakdown under Search → Release diagnostics, and the M7
health-cache feedback — then walks a concrete tuning example.

Companion: [`api.md`](./api.md) (the `/search`, `/debug/search`, and
`/config/profiles` shapes) and [`architecture.md`](./architecture.md) (where the ranker
sits).

---

## 1. The pipeline: parse → reject → rank → aggregate

Every release from every indexer flows through four stages (BRIEF §7):

```
  raw release name + newznab attrs
        │
        ▼  PARSE      (Core/Parser)          → ParsedFields
        │
        ▼  REJECT     (Core/Ranking/RejectionRules)  → 0..N RejectionReasons
        │             independent, additive rules
        ▼  RANK       (Core/Ranking/WeightedSumRanker) → integer score + per-rule breakdown
        │             a transparent weighted sum over a QualityProfile
        ▼  AGGREGATE  (Core/Search/WorkAggregator)   → works, releases sorted desc within each
```

Both `GET /search` and `POST /debug/search` run the **identical** pipeline; the debug
endpoint just projects more of it (parsed fields, score breakdown, rejection reasons,
per-indexer diagnostics). Rejected releases are dropped from `/search` results but
**kept and flagged** in `/debug/search`.

---

## 2. Parse — the fields (`parsed`)

The parser extracts, from the raw release name (BRIEF §7.1). Surfaced as `parsed` on
each `/debug/search` release:

| Field | Examples |
|---|---|
| `resolution` | `2160p`, `1080p`, `720p`, `480p`, `SD` |
| `source` | `BluRay`, `Remux`, `WEB-DL`, `WEBRip`, `HDTV`, `DVD`, `CAM`, … |
| `videoCodec` | `x265`/HEVC, `x264`/AVC, `AV1` |
| `hdr` | `DV`, `HDR10+`, `HDR10`, `HLG`, `SDR` |
| `audioCodec` + `audioChannels` + `atmos` | `TrueHD`, `DTS-HD MA`, `DTS`, `DDP`, `DD`, `AAC`; `5.1`/`7.1`; Atmos flag |
| `releaseGroup` | `GROUP` |
| `edition` | `Extended`, `Director's Cut`, `Uncut` |
| `proper` / `repack` | booleans |
| `languages[]` | ISO 639-1, incl. multi/dual-audio markers |
| `title` / `year` / `mediaType` | resolved title, year, `movie`/`tv` |
| **TV only:** `season`, `episodes[]`, `absoluteEpisodes[]` (anime), `seasonPack`, `airDate` | `S01E02`, season packs, daily-date, absolute numbering |

The parser is unit-tested against a first-class **corpus of real release names** with
expected output (BRIEF §7.1) — do not regress it by hand.

---

## 3. Reject — the rules and their codes

Six rules run before ranking (a seventh, dead-on-usenet, folds in the health check).
Each is independent, so several reasons can attach to one release. Every rejection
carries a stable machine-readable `code` (from
[`RejectionReason.cs`](../server/src/Streamarr.Core/Ranking/RejectionReason.cs)) plus a
human message — both surfaced in `/debug/search` and the Management UI.

| Code (`CodeSlug`) | Rule | Triggers when |
|---|---|---|
| `sample` | `SampleRejectionRule` | A word-boundary `sample` marker in the name, **or** size below an absolute 100 MB floor for a ≥15-minute runtime. |
| `size-too-small` | `SizeSanityRejectionRule` | bytes-per-minute (vs TMDB runtime) **below** the sane band floor for the claimed resolution — a padded fake / mislabelled sample. |
| `size-too-large` | `SizeSanityRejectionRule` | bytes-per-minute **above** the band ceiling — an absurdly oversized (often fake) upload. |
| `password-protected` | `PasswordProtectedRejectionRule` | The resolved NZB's archive is password-protected with no known password. *(post-resolve)* |
| `non-media-payload` | `NonMediaPayloadRejectionRule` | The NZB contains executables, or **no** video/archive file at all. *(post-resolve)* |
| `incomplete-upload` | `IncompleteUploadRejectionRule` | Fewer files than expected, or missing segments beyond a 2% tolerance. *(post-resolve)* |
| `dead-on-usenet` | `DeadOnUsenetRejectionRule` | The health check classified the release `dead` (STAT found the media's articles missing). |

The size-sanity band is per-resolution and comes from the profile (§4). "Post-resolve"
rules need the fetched NZB, so they fire once a release has been resolved; the
size/sample rules run at search time from the newznab size + TMDB runtime.

> **Deny list ≠ rejection.** A group on the profile's deny list is *demoted* in ranking
> (a large score penalty), not rejected — it stays selectable if nothing better exists
> (BRIEF §7.3). Only the seven codes above are rejections.

---

## 4. Rank — the weighted-sum ranker and the profile knobs

The v1 ranker
([`WeightedSumRanker.cs`](../server/src/Streamarr.Core/Ranking/WeightedSumRanker.cs))
is a **transparent weighted sum**. Every term becomes its own line in the score
breakdown, so the total is fully explained. The interface is narrow (`Score(signals,
profile) → ReleaseScore`) so a Radarr-style custom-format ranker could replace it later
without changing the API.

A **quality profile**
([`QualityProfile.cs`](../server/src/Streamarr.Core/Profiles/QualityProfile.cs)) is the
set of knobs. Every field, its default, and its effect:

### Preference lists (best-first)

| Field | Effect |
|---|---|
| `preferredResolutions` | Position in this best-first list scales `resolutionWeight`: rank 0 → full weight, decaying linearly to `weight/count` for the last. Not listed → 0. |
| `preferredSources` | Same decay against `sourceWeight`. |
| `preferredCodecs` | Same decay against `codecWeight`. |
| `preferredLanguages` | Scored by the **best-ranked** preferred language the release actually carries, against `languageWeight`. |

### Weights (points at a full match)

| Field | Default | Contributes to |
|---|---|---|
| `resolutionWeight` | `100` | Resolution preference match. |
| `sourceWeight` | `80` | Source preference match. |
| `codecWeight` | `40` | Codec preference match. |
| `languageWeight` | `60` | Language preference match. |
| `audioWeight` | `30` | Audio **tier** (lossless > high-bitrate lossy > DD/AAC > MP3), normalized to the max tier. |
| `sizeWeight` | `20` | Bitrate within the sane band — a fuller-quality encode scores higher (needs runtime). |
| `properRepackBonus` | `20` | Flat bonus if `proper` **or** `repack`. |
| `recencyBonus` | `10` | Linear decay from full at age 0 to 0 at one year old. |
| `grabsBonus` | `10` | Log scale — ~1000 grabs earns the full bonus, diminishing below. |
| `groupAllowBonus` | `50` | Added when the group is on `groupAllowList`. |
| `groupDenyPenalty` | `100000` | **Subtracted** when the group is on `groupDenyList` — large, so a denied group sinks below every accepted release without a hard rejection. |

### Group lists and size bands

| Field | Effect |
|---|---|
| `groupAllowList` | Groups that earn `groupAllowBonus`. |
| `groupDenyList` | Groups that incur `groupDenyPenalty`. |
| `minBytesPerMinute` / `maxBytesPerMinute` | Global fallback size-sanity band (defaults 3 MB/min … 1.5 GB/min). |
| `sizeBands` | Per-resolution bytes-per-minute overrides, keyed by resolution token (`"2160p"`, `"1080p"`, …). Drives **both** the `size-too-small`/`size-too-large` rejections **and** the `size` score term. |
| `isDefault` | Marks the built-in profile (read-only; cannot be edited or deleted). |

The tier orderings behind `audioWeight` and the default per-resolution size bands are
ported from Radarr (GPL-3.0) in
[`QualityDefinitions.cs`](../server/src/Streamarr.Core/Ranking/QualityDefinitions.cs);
the default bands are, per minute: `720p` 4–220 MB, `1080p` 6–450 MB, `2160p`
15–1500 MB (generous enough that a legitimate Remux never trips the ceiling).

### The built-in default (`Standard`)

From
[`DefaultProfiles.cs`](../server/src/Streamarr.Core/Profiles/DefaultProfiles.cs):
prefers `1080p` (then `2160p`, `720p`, `480p`), sources `BluRay > WEB-DL > Remux >
WEBRip > HDTV`, codecs `x265 > x264`, language `en`, with the Radarr-derived size
bands. It ships so ranking is sane out of the box before you create your own.

---

## 5. Reading the score breakdown (`/debug/search`)

Each debug release carries a `scoreBreakdown` — one `{ rule, points }` line per
contributing term (only non-zero terms appear). The `rule` names map directly to §4:

```
resolution · source · codec · language · audio · size ·
proper-repack · recency · grabs · group-allow · group-deny
```

Example for `Example.2021.1080p.WEB-DL.x265.DDP5.1-GROUP` under the Standard profile:

| rule | points | why |
|---|---|---|
| `resolution` | 100 | `1080p` is rank 0 of `["1080p","2160p","720p","480p"]` → full `resolutionWeight`. |
| `source` | 64 | `WEB-DL` is rank 1 of 5 sources → `80 × 4/5`. |
| `codec` | 40 | `x265` is rank 0 of `["x265","x264"]` → full `codecWeight`. |
| `audio` | 20 | `DDP` is audio tier 4 of 6 → `30 × 4/6`. |
| `grabs` | 3 | 34 grabs on a log scale. |
| **score** | **~227** | sum of the lines |

The exact totals are whatever the code computes — the point is the breakdown **explains
every point**, so you tune against evidence, not vibes.

### The live preview

In the Management UI's **Quality Profiles** editor, a **live preview** runs a sample
query through `POST /debug/search` using your **unsaved draft profile** (passed inline
as the request's `profile`) and shows the re-ranked ordering *before* you save. Edit a
weight, watch the order change, then save. **Search → Release diagnostics** is the
same table for an already-saved profile, with a per-release **Resolve** button to see
the health outcome + pre-probed media info.

---

## 6. M7 — the health-cache feedback loop

Ranking is not static: a release found **dead** at resolve time is remembered and fed
back (BRIEF §6.1 module 5, §7.2, §10-M7), via `ReleaseHealthCache`
([`ReleaseHealthCache.cs`](../server/src/Streamarr.Core/Media/ReleaseHealthCache.cs),
TTL `Streamarr:HealthCacheTtlSeconds`, default 1800 s):

- On the **next search** (even one that re-registers the release fresh from the
  indexer), the cached-dead classification triggers the `dead-on-usenet` rejection, so
  the release is demoted/rejected rather than offered again.
- In **auto-fallback selection**, a cached-dead release is **skipped** — the resolve
  pipeline will not walk back into a release it already knows is gone.
- Healthy classifications are cached too, so search can prefer proven-good releases.

The net effect: the ranker learns from playback. You do not have to manually deny a
release that has died — resolve once, and it self-demotes for the TTL.

---

## 7. A worked tuning example

**Goal:** prefer 1080p WEB-DL **x265**, deny a group that keeps shipping bad encodes,
and tighten the 1080p size band to cut oversized fakes.

1. **Start from Standard** (clone it in the Quality Profiles editor).
2. **Reorder preferences** so the intent is explicit:
   ```json
   {
     "name": "1080p WEB-DL x265",
     "preferredResolutions": ["1080p", "2160p", "720p"],
     "preferredSources": ["WEB-DL", "BluRay", "WEBRip"],
     "preferredCodecs": ["x265", "x264"],
     "preferredLanguages": ["en"]
   }
   ```
3. **Deny the bad group:**
   ```json
   { "groupDenyList": ["BADGROUP"] }
   ```
   Its releases now take `−100000` (`group-deny`) and sink below everything accepted —
   but stay selectable if they are somehow the only option.
4. **Tighten the 1080p band** (reject anything over ~350 MB/min at 1080p as likely
   fake/mislabelled):
   ```json
   {
     "sizeBands": {
       "1080p": { "minBytesPerMinute": 8000000, "maxBytesPerMinute": 350000000 }
     }
   }
   ```
   Now an oversized "1080p" upload trips `size-too-large`.
5. **Validate in the playground.** With the draft profile live-previewed against a real
   query:
   - the 1080p WEB-DL x265 release rises to the top (check its `resolution`/`source`/
     `codec` breakdown lines are all at full weight);
   - the denied group's release shows a `group-deny` line and sits at the bottom;
   - the oversized fake now shows a `size-too-large` rejection instead of a score.
6. **Save**, then optionally set it as the profile a search uses via `profileId`
   (or per-request in `/search`/`/debug/search`).

Tune against the breakdown, not in the dark — that is exactly what the debug playground
is for (BRIEF §9.1).

---

## See also

- [`api.md`](./api.md) — `/search`, `/debug/search`, and `/config/profiles` shapes.
- [`architecture.md`](./architecture.md) — where parse/reject/rank sits and how the
  health cache closes the loop.
