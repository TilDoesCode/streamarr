# D1: Visual identity, three directions

Open **[directions.html](./directions.html)** in any browser (self-contained: artwork embedded as base64, fonts from Google Fonts). PNG renders of every mockup are in [`jpg/`](./png).

The user said the app is "very plain and boring", has "no visual identity", and "web and TV diverge too much". Today the app is a neutral dark UI with a default violet accent and system fonts. Nothing in it could only be Streamarr. Each direction below is a complete identity, not a colour swap. All three are dark only, use Google Fonts (OFL, can be bundled with `expo-font`) and share the **one large-screen shell** described in the HTML.

| Direction | One line | Fonts | Signature | Effort |
|---|---|---|---|---|
| **A · Projector** | Cinematic and warm: the living room becomes a screening room | Fraunces (display serif) + Instrument Sans | Letterboxed hero, amber light bloom behind focus, film grain, italic serif section heads | M |
| **B · Signal** | Broadcast control room: Streamarr shows the stream internals, so it wears them | Archivo Expanded + Archivo + JetBrains Mono | Mono spec labels (codec, HDR, method), signal-bar health, corner-bracket focus, hairline grid, 0 radius | M |
| **C · Aurora** | Ambient and artwork-driven: every title paints the room | Outfit + Figtree | Blurred backdrop and accent tinted from the focused title's dominant colour, soft glass surfaces, spring focus | L |

## Files

| File | What |
|---|---|
| `directions.html` | The deliverable: shell section, then per direction a brand block and the four mockups (≈1.1 MB) |
| `jpg/{A,B,C}-brand.jpg` | Brand block: wordmark, app icon, colour tokens, type ramp, focus/hover/press, motion (1920×1080) |
| `jpg/{A,B,C}-home.jpg` | (1) Large-screen home with TV focus and an inset of the same screen on web with hover + pointer (1920×1080) |
| `jpg/{A,B,C}-home-web.jpg` | (1b) The web desktop home at full size (1920×1080) |
| `jpg/{A,B,C}-detail.jpg` | (2) Movie detail with the version panel open (1920×1080) |
| `jpg/{A,B,C}-player.jpg` | (3) Player overlay with the info panel (1920×1080) |
| `jpg/{A,B,C}-phone.jpg` | (4) Phone detail (390×844) |
| `src/build.mjs`, `src/styles.css` | Generator: `node src/build.mjs` writes `directions.html` from `src/s/*` (downscaled Dev World artwork) |
| `src/render.sh` | Renders all PNGs with the Playwright headless Chromium (`--mute-audio`), using `directions.html?shot=<frame-id>` |

## Tokens

### A · Projector

| Token | Value | Use |
|---|---|---|
| bg | `#0D0A07` | warm ink black; letterbox bars are pure `#000` |
| surface | `#17120D` | version cards, phone version row |
| raised | `#221A12` | focused card surface |
| line | `#3A2E22` | hairlines, progress track |
| fg | `#F4EADB` | text (warm paper) |
| muted | `#A99A85` | secondary text |
| accent | `#F2A43A` | projector amber: primary button, progress, active nav, bloom |
| accent2 | `#E0662C` | bloom falloff, press |
| ok / warn / bad | `#9BC27A` / `#F2C14E` / `#E4573D` | direct play / direct stream / transcode |
| focus ring | `#FFD89A` 3 px + amber radial bloom | TV focus |
| radius | 4 (buttons), 6 (cards), 8 (panels) | |
| type | Display Fraunces 600 96/0.95 opsz 144 SOFT 50 · Section Fraunces 500 italic 40 · Title Instrument Sans 600 22 · Body Instrument Sans 400 24 (TV) / 17 (web, phone) · Label Instrument Sans 600 15 caps +14% | |
| motion | focus 220 ms ease-out-quint, scale 1.06, bloom 320 ms; hero dissolve 600 ms + 1.5% push-in; letterbox slide 400 ms | |

### B · Signal

| Token | Value | Use |
|---|---|---|
| bg | `#07080A` | near black |
| surface | `#0E1013` | spec strips, version cards |
| raised | `#15181D` | avatar, controls |
| line | `#262A31` | 1 px hairlines, 120 px background grid at 3.5% white |
| fg | `#F2F4F7` | text |
| muted | `#8A919C` | secondary text, spec keys |
| accent | `#D4FF3A` | electric lime: the only signature colour; active nav, focus brackets, direct play, signal bars |
| accent2 | `#3AE0FF` | direct stream |
| warn / bad | `#FFB224` / `#FF4D4D` | transcode + degraded / errors |
| focus | 4 px lime corner brackets + 2 px lime outline, card lifts 6 px, spec strip turns lime | TV focus (hover: same brackets at 55%) |
| radius | 0 everywhere | |
| type | Display Archivo Expanded (wdth 125) 800 96–104/0.9 caps · Section Archivo Expanded 800 24 caps + mono index · Title Archivo 600 22 · Body Archivo 400 24 / 16 · Spec JetBrains Mono 500 15 caps +4% | |
| motion | focus 90 ms linear snap, no scale; hero 120 ms wipe; spec chips type in (40 ms stagger); numbers tick, never tween | |

### C · Aurora

| Token | Value | Use |
|---|---|---|
| bg | `#0A0C12` + radial washes of `--tint` / `--tint2` | base behind the blurred backdrop |
| ambient | backdrop, blur 70 px, saturate 1.5, brightness .55 | full-screen, crossfades with focus |
| tint / tint2 | per title (e.g. Sprite Fright `#3FCF7A`/`#0F3A26`, Bunny `#9CCC52`/`#26361A`, Cosmos `#D99A3E`/`#5A3A1C`) | accent, glows, badges |
| glass | `rgba(255,255,255,.07–.16)` + backdrop blur 30–40 px + 1 px top highlight `rgba(255,255,255,.2)` | rail, panels, player bar, tab bar |
| fg / muted | `#FFFFFF` / `rgba(255,255,255,.64)` | |
| ok / warn / bad | `#6FE3A5` / `#FFD166` / `#FF7A8A` | methods, health |
| focus | scale 1.10, 4 px white ring, 60 px glow in `--tint`, neighbours shift right | TV focus (hover: scale 1.04, 2 px ring) |
| radius | 20–22 (cards), 28 (version cards), 40 (panels), 999 (buttons, chips) | |
| type | Display Outfit 700 92/1.0 −2.5% · Section Outfit 600 32 · Title Figtree 600 22 · Body Figtree 400 24 / 17 · Label Figtree 600 16 | |
| motion | focus spring (damping 18, stiffness 180); ambient + tint crossfade 700 ms (debounced 150 ms); panels rise 24 px + fade 280 ms; reduced motion = crossfade only | |

## Implementation notes

**A · Projector (M).** Bundle Fraunces (variable, roman + italic, Latin subset) and Instrument Sans with `expo-font`; web uses the same files. Film grain is one 256 px tiled PNG (≈18 KB) at 6% opacity, skipped on low-RAM Android TV. The bloom is a pre-rendered radial PNG behind the focused card (no runtime blur on TV GPUs). The letterboxed hero is pure layout. No server change.

**B · Signal (M).** Bundle Archivo (variable with the width axis on web; static Expanded 800 + Regular/SemiBold instances on native) and JetBrains Mono 500. Card spec strips need codec/HDR/audio of the default version on list items: a small catalog DTO addition (`videoCodec`, `hdr`, `audioLayout`), or derive it from the existing version summary. Signal bars map the existing health (ready/degraded) and local state (instant/preparing) to 4/2 bars in one component. The info-panel throughput sparkline samples player bitrate each second on the client. Zero radius is a token change.

**C · Aurora (L).** Needs a dominant colour per title. Recommended: extract a palette on the server when artwork is cached (for example k-means on the backdrop with SkiaSharp/ImageSharp, 2 swatches) and expose `tint`/`tint2` on the catalog DTOs. The client alternative (`react-native-image-colors`) costs per image on TV. The blurred ambient backdrop uses `expo-image` `blurRadius` on native and CSS `filter` on web; a small pre-blurred variant from the server is cheaper on TV. Glass uses `expo-blur` on native (iOS Liquid Glass later via `expo-glass-effect`), `backdrop-filter` on web, and a solid rgba fallback on Android TV. Backdrop and tint crossfade on focus through a Reanimated shared value. Bundle Outfit and Figtree.

## One large-screen shell (all directions)

TV, web desktop and tablet render one layout at 1920×1080 logical points: a 104 px navigation rail with the brand mark and profile, a 660 px hero that follows focus/hover, 352×198 landscape and 208×312 poster cards with 24 px gaps from x = 168, a detail page with a 780 px right version panel, and a player overlay with 620 px right side panels. Only the input differs: D-pad focus on TV; pointer hover, row arrows and keyboard shortcuts on web. Details and the comparison with today's divergence are in the HTML.

Artwork: Blender Foundation open movies and Sherlock (BBC) via TMDB, as used by Dev World.

# D2: Widescreen detail concept (TV, iPad/tablet, web desktop)

Open **[detail-concept.html](./detail-concept.html)** (German, self-contained, ≈1.8 MB; page chrome follows light/dark mode, the mockups stay in the dark Aurora look). The user asked (2026-10-02) for content first on large screens: versions are a technical detail and move into a sheet; series show their episodes side by side at the bottom, the selected episode drives the copy and buttons above; series facts get a smaller column on the right.

**Recommendation: variant 1 · Bühne (stage).** One page without scrolling, anchored to the bottom edge: copy + actions left (x = 168), "Über die Serie"/"Details" glass column right (460 wide, bottom-aligned with the actions), season chips, then a 352×198 episode strip 72 pt above the bottom. Play plays the recommended version; "Versionen · N" (1 version: "Details", none: hidden) opens the existing `versions/[workId]` route as a sheet on every device. TV: focus on an episode previews it above (150 ms), Select plays it, holding Select opens its versions; every focus path is a straight row so Apple TV works by geometry alone; Menu closes the sheet, otherwise leaves the page (Android TV adds strip → actions). Alternatives in the HTML: 2 · Ebenen (scrolling layers), 3 · Spotlight (episode still as backdrop). Phones are unchanged.

| File | What |
|---|---|
| `detail-concept.html` | The deliverable: problem, three variants, the recommended variant in full (movie states, version sheet per platform, series strip, TV focus map + Menu chain, iPad/web/tablet frames, loading/error, phone), F7 implementation outline, open questions |
| `jpg/D2-v1-buehne.jpg`, `D2-v2-ebenen.jpg`, `D2-v3-spotlight.jpg` | The three variants (TV 1920×1080) |
| `jpg/D2-movie-{default,resume,states}.jpg` | Movie: default, resume, and a board with watched / no version / one version / transcode-only |
| `jpg/D2-sheet-{tv,web}.jpg`, `D2-sheet-ipad.jpg` | Version sheet on TV (1920), web drawer (1920), iPad formSheet (1366×1024) |
| `jpg/D2-series-{initial,strip,season3}.jpg` | Series on open, focus moving in the strip, season without versions + specials + long title |
| `jpg/D2-focus-map.jpg`, `D2-apple-tv.jpg` | TV focus map with arrows and the Back chain; the same page under the tvOS tab bar |
| `jpg/D2-ipad-{landscape,portrait,window}.jpg`, `D2-tablet-square.jpg`, `D2-web-{1280,1920}.jpg` | iPad Pro 13 landscape/portrait, Stage Manager window 980×760, near-square tablet 1180×1080, web 1280×800 and 1920×1080 with hover |
| `jpg/D2-loading.jpg`, `D2-error.jpg`, `D2-phone.jpg` | Skeleton, section-level error, phone (unchanged) |
| `src/d2/build.mjs`, `data.mjs`, `doc.mjs`, `styles.css` | Generator (frames, mock data, German text, styles) |
| `src/d2/sherlock.json`, `src/d2/s/` | Sherlock seasons/episodes in German and downscaled episode stills from the Dev World viewer API (throwaway viewer, deleted), current-state screenshots |
| `src/d2/render.sh` | Renders every frame (or the given ids) with the Playwright headless Chromium (`--mute-audio`) to `png/` (git-ignored) and `jpg/` |

Rebuild: `node docs/client/design/src/d2/build.mjs && sh docs/client/design/src/d2/render.sh`. Frames are drawn in logical points and scaled per device (`data-k`: iPad 0.72, portrait/window 0.7, web 1280 0.667, tablet 0.66).

## D2b: decision Bühne + version chip row + no-navigation rule

Files: section „0 · Entscheidung und Nachtrag (D2b)“ in `detail-concept.html` (same generator: `node docs/client/design/src/d2/build.mjs && sh docs/client/design/src/d2/render.sh`), renders `jpg/D2b-movie-direct.jpg`, `D2b-movie-transcode.jpg`, `D2b-movie-resume-other-version.jpg`, `D2b-series-strip-chips.jpg`, `D2b-series-switch-sequence.jpg` (1920 × 1240), `D2b-chip-states.jpg` (1920 × 1300), `D2b-chip-fit.jpg`, `D2b-ipad.jpg` (1366 × 1024), `D2b-web-1280.jpg` (1280 × 800); all `D2-*` Bühne renders re-rendered with the chip row. Chip data lives in `src/d2/data.mjs` (`CH`, `METHOD_SHORT`), the component in `build.mjs` (`vrow`, `fitChips`).

The user chose variant 1 Bühne (variants 2 and 3 stay in the document, marked „nicht gewählt“) and added two rules. (1) Changing episode or season is screen-local state: copy, buttons, chips, marker and backdrop update in place, never `push/replace/setParams/navigate`, no web history entry or hash, Back leaves the page; `history.replaceState` is possible but not recommended. (2) A fixed-height chip row (104 pt) under Play/Resume describes exactly the version that button starts (`playTarget()`, shared with the play call; Resume = `watch.lastReleaseId` when still offered, else recommended): method chip first and strongest (Direkt / Direkt-Stream / Transkodiert / Mit VLC / Ungeprüft, colours from `methodTone()`), then resolution · HDR · video · audio · source · size, a reason line (max. two short reasons, or the old „4K · HDR10 vorhanden“ gap note, or „Direkt möglich: …“ when resuming another version). Never wraps; drop order size → source → audio codec → video codec. Not focusable on TV; web shows the long reasons in a tooltip, iPad tap opens the sheet. Server data gaps: target codec (`to`) for `video_codec_unsupported`, name of a no-longer-listed last-played release (optional), season-pack size is the whole pack (size chip hidden), prediction can differ from the decision at start.
