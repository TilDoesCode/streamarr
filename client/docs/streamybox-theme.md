# Streamybox theme

On a Streamybox Android TV box the client switches automatically to a token set
that matches the system UI (launcher, Store, Settings): a calmer cool-dark palette, Inter, Streamybox's TV
type scale, its radii, a slim focus ring with a 1.04 lift and its 170 ms no-bounce motion. Screens,
navigation, features and the poster/backdrop layout are unchanged. There is no settings switch.

## Detection

`modules/host-system` (Android only) exposes a constant `theme`, read once, synchronously, when
`src/theme/tokens.ts` is evaluated, so before the first render and before any module-scope style reads
a token.

1. **Primary:** `PackageManager.hasSystemFeature("dev.streamybox.tv", 1)`. The box declares the feature
   (Streamybox `docs/36-app-integration.md`).
2. **Fallback:** `dev.streamybox.settings` is installed **as a system app**. The package is visible
   through a `<queries>` entry added by `plugins/with-android-tv.js`. A sideloaded copy doesn't count.

Everywhere else (iOS, tvOS, web, phones, plain Android TV, builds without the module) `theme` is
`default` and every token is the same object as before.

### Forcing it for testing (debuggable builds only)

```sh
adb shell setprop debug.streamarr.theme streamybox   # or: default
adb shell am force-stop dev.streamarr.app            # the theme is resolved at process start
```

Release builds ignore the property.

## Tokens

| Token | Default | Streamybox |
|---|---|---|
| `colors` | `colors.json` | `colors.json` merged with `colors-streamybox.json` (background, surfaces, foreground tones, primary/secondary, accent blue `#8CC4FF`, aurora wash, glass, info, border/input/muted, focus ring + glow, scrims, quiet brand gradient). Semantic, avatar, QR and video colours stay. |
| `fonts` | Outfit / Figtree / JetBrains Mono | Inter (`Inter-DisplayBold` for display/title, `Inter-SemiBold`, `-Medium`, `-Regular`) |
| `typeRamp.tv` | 44/28/19/16/14/13/11 … | 38/28/18/16/14/13/12, eyebrow 11 with 0.14 em tracking |
| `radius` | sm 6, md 12, xl 28 | sm 8, md 14, xl 26 |
| `focusTokens.tv` | card 1.1, button 1.06, ring 3 + 3 offset | 1.04 / 1.04, ring 2 + 1 offset (air unchanged, so row spacing stays) |
| `motion`, `springs`, `easing` | spring 18/180 | 170 ms critically damped spring, decelerate (0.05, 0.7, 0.1, 1) |

All overrides are in `src/theme/streamybox.ts` and `src/theme/colors-streamybox.json`.
`src/theme/streamybox.test.ts` checks that the default tokens are unchanged, and that the Streamybox
set replaces exactly the listed tokens, keeps each colour's format (hex stays hex), keeps layout and
spacing, and uses a focus spring that can't overshoot.

Two small styling hooks handle values that are not read from the tokens at runtime:

- `components/ui/text.tsx`: the NativeWind tone classes are compiled from the default `colors.json`, so
  under a host theme the tone colour is also set inline.
- `shell/shell-rail.tsx`: the active tab is a raised pill (Streamybox tab language) instead of the white
  disc.

## Fonts

Inter © The Inter Project Authors, SIL Open Font License 1.1 (`assets/fonts/OFL-Inter.txt`). The four
static faces were instanced from Streamybox's bundled variable `Inter.ttf` (`wght` 400/500/600 at
`opsz` 16 and `wght` 700 at `opsz` 32, the same values Streamybox's `TvDesign` uses) and subset to
Latin, punctuation and arrows (about 720 KB in total). The OFL allows modified versions; Inter declares
no Reserved Font Name.
