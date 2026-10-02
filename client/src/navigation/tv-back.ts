export type TvBackAction = 'closeRail' | 'rail' | 'navigate' | 'home' | 'confirmExit';

/** Android TV Back: close the rail, a tab page hands focus to the rail, else pop / return Home, else confirm leaving. */
export function tvBackAction({
  railFocused,
  railByBack = false,
  canGoBack,
  atHome = true,
  atTabPage = false,
}: {
  railFocused: boolean;
  /** The rail got focus from a screen's Back chain: the next Back leaves the screen instead of returning into it. */
  railByBack?: boolean;
  canGoBack: boolean;
  /** The Home tab's root screen is showing. */
  atHome?: boolean;
  /** The root screen of a tab other than Home (Search, Movies, Series, Settings). */
  atTabPage?: boolean;
}): TvBackAction {
  if (railFocused && !railByBack) return 'closeRail';
  if (atTabPage && !railFocused) return 'rail';
  if (canGoBack) return 'navigate';
  return atHome ? 'confirmExit' : 'home';
}

export type ExitDialogEvent =
  { type: 'open'; path: string } | { type: 'close' } | { type: 'route'; path: string };

/** The exit dialog belongs to the path it opened on; leaving that path forgets it for good. */
export function exitDialogReducer(openAt: string | null, event: ExitDialogEvent): string | null {
  if (event.type === 'open') return event.path;
  if (event.type === 'close') return null;
  return openAt === event.path ? openAt : null;
}
