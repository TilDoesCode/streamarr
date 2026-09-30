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
