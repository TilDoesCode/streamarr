import { POP_SYNC_TIMEOUT_MS, handleTitleLink, type TitleLinkDeps } from './title-link-intent';
import { routeFromUrl, type LinkState } from './title-link';

const home = (...ids: string[]): LinkState => ({
  routes: [
    {
      name: '(home)',
      state: {
        key: 'home-stack',
        routes: [{ name: 'index' }, ...ids.map((id) => ({ name: 'movie/[id]', params: { id } }))],
      },
    },
  ],
});

function deps(root: LinkState, popToScreen: TitleLinkDeps['popToScreen'] = () => null) {
  const listeners = new Set<() => void>();
  const value = {
    root,
    stateFromPathInner: (route: string): LinkState => {
      const id = /^\/movie\/([^/?]+)/.exec(route)?.[1];
      return id ? home(id) : { routes: [{ name: 'settings' }] };
    },
    stateFromPath: (route: string): LinkState | undefined => {
      const id = /^\/movie\/([^/?]+)/.exec(route)?.[1];
      return id ? home(id) : { routes: [{ name: 'settings' }] };
    },
    rootState: () => value.root,
    dispatch: jest.fn(),
    open: jest.fn(),
    popToScreen: jest.fn(popToScreen),
    onState: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The navigator reports a new state. */
    emit: (next: LinkState) => {
      value.root = next;
      listeners.forEach((listener) => listener());
    },
  };
  return value;
}

describe('routeFromUrl (I4 review: both link forms dedupe the same)', () => {
  it.each([
    ['streamarr:///movie/1', '/movie/1'],
    ['streamarr://movie/1', '/movie/1'],
    ['dev.streamarr.app://series/7?season=2', '/series/7?season=2'],
    ['/movie/1', '/movie/1'],
    ['https://streamarr.example/movie/1', '/movie/1'],
  ])('%s -> %s', (url, route) => {
    expect(routeFromUrl(url)).toBe(route);
  });
});

describe('handleTitleLink (I4 item 8)', () => {
  it('lets the router open a title that is not in the stack', () => {
    const d = deps(home('1'));
    expect(handleTitleLink('streamarr:///movie/2', d)).toBe('streamarr:///movie/2');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it.each(['streamarr:///movie/1', 'streamarr://movie/1'])(
    'keeps %s on the open title without a second copy',
    (url) => {
      const d = deps(home('1'));
      expect(handleTitleLink(url, d)).toBeNull();
      expect(d.dispatch).not.toHaveBeenCalled();
    }
  );

  it('pops back in JS where there is no native pop', () => {
    const d = deps(home('1', '2', '3'));
    expect(handleTitleLink('streamarr://movie/1', d)).toBeNull();
    expect(d.dispatch).toHaveBeenCalledWith({
      type: 'POP',
      payload: { count: 2 },
      target: 'home-stack',
    });
  });

  it('asks the native pop for the page with exactly that many pages above it (Apple TV)', async () => {
    const d = deps(home('1', '2'), () => Promise.resolve(true));
    expect(handleTitleLink('streamarr:///movie/1', d)).toBeNull();
    expect(d.popToScreen).toHaveBeenCalledWith('movie-screen-1', 1);
    await Promise.resolve();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('leaves the player and the stack under it alone (the viewer closes the player)', () => {
    const covered: LinkState = {
      type: 'stack',
      index: 1,
      routes: [{ name: '(tabs)', state: home('1', '2') }, { name: 'play/[playbackId]' }],
    };
    const d = deps(covered, () => Promise.resolve(true));
    d.stateFromPath = (route: string) => ({
      routes: [{ name: '(tabs)', state: d.stateFromPathInner(route) }],
    });
    expect(handleTitleLink('streamarr:///movie/1', d)).toBeNull();
    expect(d.popToScreen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('switches to the hidden tab first and returns to the title once that tab is in view', async () => {
    jest.useFakeTimers();
    const inMovies = (stack: LinkState): LinkState => ({
      type: 'tab',
      key: 'tabs',
      index: 1,
      routes: [...stack.routes, { name: '(movies)' }],
    });
    const d = deps(inMovies(home('1', '2')), () => Promise.resolve(true));
    expect(handleTitleLink('streamarr:///movie/1', d)).toBeNull();
    expect(d.dispatch).toHaveBeenCalledWith({
      type: 'JUMP_TO',
      payload: { name: '(home)' },
      target: 'tabs',
    });
    expect(d.popToScreen).not.toHaveBeenCalled();
    d.emit({ ...inMovies(home('1', '2')), index: 0 });
    expect(d.popToScreen).toHaveBeenCalledWith('movie-screen-1', 1);
    jest.useRealTimers();
  });

  it('gives up after the bound when the tab switch never reaches the state', () => {
    jest.useFakeTimers();
    const d = deps(
      {
        type: 'tab',
        key: 'tabs',
        index: 1,
        routes: [...home('1', '2').routes, { name: '(movies)' }],
      },
      () => Promise.resolve(true)
    );
    handleTitleLink('streamarr:///movie/1', d);
    jest.advanceTimersByTime(POP_SYNC_TIMEOUT_MS);
    expect(d.popToScreen).not.toHaveBeenCalled();
    // No retry loop: the tab switch is asked for once, also long after the bound.
    jest.advanceTimersByTime(POP_SYNC_TIMEOUT_MS * 5);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.open).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('opens the title like a fresh link when it was closed while the tab switched (V1 leftover)', () => {
    jest.useFakeTimers();
    const tabs = (stack: LinkState, index: number): LinkState => ({
      type: 'tab',
      key: 'tabs',
      index,
      routes: [...stack.routes, { name: '(movies)' }],
    });
    const d = deps(tabs(home('1', '2'), 1), () => Promise.resolve(true));
    handleTitleLink('streamarr:///movie/1', d);
    // The tab is in view, but its stack no longer holds the title.
    d.emit(tabs(home(), 0));
    expect(d.popToScreen).not.toHaveBeenCalled();
    expect(d.open).toHaveBeenCalledWith('/movie/1');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
