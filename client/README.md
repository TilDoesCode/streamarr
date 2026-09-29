# Streamarr client

Viewer app for phones, tablets, Android TV / Google TV, Apple TV and the web. Expo SDK 57
(React 19.2, React Native 0.86 via `react-native-tvos`), Expo Router, NativeWind 4.2 +
Tailwind 3.4, React Native Reusables. Binding spec: [`docs/client/PLAN.md`](../docs/client/PLAN.md);
progress and decisions: [`docs/client/journal/`](../docs/client/journal/).

## Setup

```sh
source ../docs/client/env.sh   # JDK 17, Android SDK
npm install                    # .npmrc sets legacy-peer-deps (react-native-tvos prerelease tag)
```

Add Expo-managed packages with `npx expo install <pkg>` so versions match the SDK.

## Scripts

| Script                                   | What it does                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run web`                            | Expo web dev server on port 39301                                                                    |
| `npm start`                              | Metro (port 8081) for development builds                                                             |
| `npm run android` / `npm run tv:android` | Prebuild + build + run on Android. Both produce the same APK (phone and Google TV)                   |
| `npm run ios` / `npm run tv:ios`         | Prebuild `ios/` for iPhone/iPad or tvOS (clean prebuild when the target switches) + run. Needs Xcode |
| `npm run typecheck` / `lint` / `test`    | `tsc`, `expo lint` (ESLint + Prettier), Jest (`jest-expo`)                                           |
| `npm run format`                         | Prettier (with the Tailwind class sorter)                                                            |
| `npm run gen:api`                        | Generate `src/api/schema.d.ts` from `server/openapi/v1.json`                                         |

Codecraft actions: `client-web` (Expo web, 39301) and `client-metro` (Metro, 8081).

## Native projects

`android/` and `ios/` are generated (Continuous Native Generation) and git-ignored. All native
configuration lives in `app.config.ts` and `plugins/`:

- `plugins/with-android-tv.js` makes every Android build TV-capable (leanback launcher, banner,
  touchscreen not required), so one APK runs on phones and Google TV. The UI branches on
  `Platform.isTV`. It also turns off the dev menu's floating button by default (it is focusable on TV
  and covers content); open the dev menu with `adb shell input keyevent 82` or `m` in Metro.
- `package.json` → `reanimated.staticFeatureFlags` sets `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS: false`
  (read at native build time). With Reanimated 4.5's default, settled animated styles are only kept if a
  JS timer hands them back to React within 1–2 s; a late timer (seen on Google TV) drops them and the
  next React commit restores stale styles (invisible Sheet, stale focus rings). Changing the flag needs
  a native rebuild.
- `@react-native-tvos/config-tv` retargets `ios/` to tvOS only when `EXPO_TV=1`.
- `plugins/with-gradle-limits.js` caps Gradle at `-Xmx2g` and 4 workers.

Dev build on an emulator without `expo run` (lets the emulator boot after the build):

```sh
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a && ./gradlew --stop
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081 && npm start
adb shell am start -a android.intent.action.VIEW \
  -d "exp+streamarr://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" dev.streamarr.app
```

## Conventions

- Routes only in `src/app`; screens composed in `src/screens`, reusable UI in `src/components`
  (`ui/` primitives, `media/` cards/shelves/hero, `states/` empty + error, `focus/` TV focus).
- Design tokens live in `src/theme`: colours and radii in `colors.json` / `radius.json` (also fed
  to Tailwind, so `bg-surface-raised`, `text-foreground-muted` etc. match), spacing, type ramps,
  layouts, focus and motion tokens in `tokens.ts`. `useDesign()` resolves them for the current form
  factor (`phone | tablet | tv | desktop-web`); TV values are authored for Android TV's 960 dp canvas
  and scaled (`px()`), so tvOS (1920 pt) gets the same proportions. ESLint rejects raw hex/rgb colours,
  CSS colour names on colour props and Tailwind's default palette classes (`bg-white`, `text-red-500`).
- Dark only. Primary actions are white, the accent (violet) marks watch state and selection.
- TV focus: wrap interactive things in `Focusable` with a `FocusLift` inside (UI-thread scale + ring),
  group rows in `FocusGuide` (`TVFocusGuideView`: remembers the last focused child, `END_OF_ROW` stops
  focus at the right end of a row that starts at the gutter, `CENTRED_ROW` at both ends of a centred
  group such as `EmptyState` actions, where Android would otherwise take any focusable further left on
  the page), use `Shelf` for horizontal rows (memory across remounts via `memoryKey`), `useBackHandler`
  for back/menu. `hasTVPreferredFocus` is only forwarded on TV. Vertical lists that should always be
  entered at the item nearest the entry point use `remember={false}`.
- TV scrolling: pages are a `ScrollView` with `snapToAlignment="item"` whose blocks are `FocusSection`s
  (a `Hero` / `Shelf` snaps itself). A section that fits the screen snaps its top under the overscan
  margin; a taller one (grids, long lists) centres the focused item instead, so focus never leaves the
  screen. Do not put `scrollSnapAlign` on tall containers: the outermost snap target wins. Snapping only
  runs on focus changes, so TV pages also set `maintainVisibleContentPosition={{ minIndexForVisible: 0 }}`:
  a relayout above the viewport (language switch, a row loading) then keeps the visible blocks, and the
  focused one, in place (see the gallery).
- Overlays (`Dialog`, `Sheet`) wrap their content in `FocusLayer` (hides the trigger's focus look under
  the scrim on TV; sibling and nested overlays are counted) and take initial focus on TV and web
  keyboard (`preferred`, via `useInitialFocus` after mount). Enter/exit are mount animations
  (`entering`/`exiting`): never leave an overlay's resting position to a JS-started animation.
  `Sheet` options scroll (TV: the focused option stays centred; phone: drag the header once the list
  scrolls); on web they are one radio group with a single Tab stop and arrow keys.
- TV grids: one `FocusGuide` per visual line (`trap={END_OF_ROW}`, no `remember`), as in the gallery's
  `GalleryGrid`; a single wrapping guide lets right at a line end jump to the line above.
- The gallery's `FocusStop` (a focus stop for non-interactive content) exists only on TV; elsewhere it is a
  plain View, so it adds no web Tab stops.
- i18n: ICU MessageFormat (`i18next-icu`) in `src/i18n/locales/{en,de}.json` — `{name}`,
  `{count, plural, one {…} other {…}}`. Device language unless the per-device override (MMKV) is set;
  formatters in `src/i18n/format.ts`. Tests enforce de/en key + argument parity and no literal UI text
  (JSX text and children incl. ternaries/fragments, text props, and text-prop keys in object literals,
  `.ts` and `.tsx`).
- `/dev/gallery` renders every component and state (linked from the placeholder home in dev builds).
- `scripts/render-placeholder-assets.mjs` regenerates the placeholder icons, splash and TV art.
