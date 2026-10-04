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
    stateFromPath: (route: string) => {
      const id = /^\/movie\/([^/?]+)/.exec(route)?.[1];
      return id ? home(id) : { routes: [{ name: 'settings' }] };
    },
    rootState: () => value.root,
    dispatch: jest.fn(),
    navigate: jest.fn(),
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

  it('shows another tab only once the pop reached the navigation state', async () => {
    jest.useFakeTimers();
    const root = home('1', '2');
    const otherTab: LinkState = { index: 1, routes: [...root.routes, { name: '(movies)' }] };
    const d = deps(otherTab, () => Promise.resolve(true));
    handleTitleLink('streamarr:///movie/1', d);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.navigate).not.toHaveBeenCalled();
    d.emit({ index: 1, routes: [...home('1').routes, { name: '(movies)' }] });
    expect(d.navigate).toHaveBeenCalledWith('/movie/1');
    jest.useRealTimers();
  });

  it('shows the tab after the bound when the state never reports the pop', async () => {
    jest.useFakeTimers();
    const d = deps({ index: 1, routes: [...home('1', '2').routes, { name: '(movies)' }] }, () =>
      Promise.resolve(true)
    );
    handleTitleLink('streamarr:///movie/1', d);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(POP_SYNC_TIMEOUT_MS - 1);
    expect(d.navigate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(d.navigate).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
