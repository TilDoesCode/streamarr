export type TvBackAction = 'closeRail' | 'navigate' | 'confirmExit';

/** Android TV Back: close the rail, else let navigation pop / return to Home, else confirm leaving the app. */
export function tvBackAction({
  railFocused,
  canGoBack,
}: {
  railFocused: boolean;
  canGoBack: boolean;
}): TvBackAction {
  if (railFocused) return 'closeRail';
  return canGoBack ? 'navigate' : 'confirmExit';
}
