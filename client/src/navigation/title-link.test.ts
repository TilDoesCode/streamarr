import { titleLinkAction, type LinkState } from './title-link';

const movie = (id: string) => ({ name: 'movie/[id]', params: { id } });
const series = (id: string) => ({ name: 'series/[id]/index', params: { id } });

/** Root state with the Home tab stack `home`, the focused tab `tab` and an optional player above the tabs. */
function root(home: LinkState['routes'], tab = 0, player = false): LinkState {
  return {
    routes: [
      {
        name: '__root',
        state: {
          routes: [
            {
              name: '(app)',
              state: {
                type: 'stack',
                index: player ? 1 : 0,
                routes: [
                  {
                    name: '(tabs)',
                    state: {
                      type: 'tab',
                      key: 'tabs',
                      index: tab,
                      routes: [
                        { name: '(home)', state: { key: 'home-stack', routes: home } },
                        { name: '(movies)' },
                      ],
                    },
                  },
                  ...(player ? [{ name: 'play/[playbackId]' }] : []),
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

/** What expo-router's getStateFromPath returns for a title link (it lands in the Home tab). */
const link = (leaf: { name: string; params: { id: string } }): LinkState => ({
  routes: [
    {
      name: '(app)',
      state: {
        routes: [
          {
            name: '(tabs)',
            state: { routes: [{ name: '(home)', state: { routes: [{ name: 'index' }, leaf] } }] },
          },
        ],
      },
    },
  ],
});

describe('titleLinkAction (I4 item 8: deep link to a title that is already open)', () => {
  it('opens a title that is not in the stack (the router pushes it)', () => {
    expect(titleLinkAction(link(movie('2')), root([{ name: 'index' }, movie('1')]))).toEqual({
      type: 'open',
    });
  });

  it('pops back to the open title instead of moving it to the top', () => {
    const current = root([{ name: 'index' }, movie('1'), movie('2'), movie('3')]);
    expect(titleLinkAction(link(movie('1')), current)).toEqual({
      type: 'pop',
      count: 2,
      stackKey: 'home-stack',
      screenTestID: 'movie-screen-1',
      place: { kind: 'shown' },
    });
  });

  it('stays on the title when it is already on top', () => {
    expect(titleLinkAction(link(series('7')), root([{ name: 'index' }, series('7')]))).toEqual({
      type: 'stay',
      place: { kind: 'shown' },
    });
  });

  it('names the tab to switch to when the landing stack is in another tab', () => {
    const current = root([{ name: 'index' }, movie('1'), movie('2')], 1);
    expect(titleLinkAction(link(movie('1')), current)).toMatchObject({
      type: 'pop',
      place: { kind: 'tab', tabsKey: 'tabs', tabName: '(home)' },
    });
  });

  it('marks a landing stack under the player as covered', () => {
    const current = root([{ name: 'index' }, movie('1'), movie('2')], 0, true);
    expect(titleLinkAction(link(movie('1')), current)).toMatchObject({
      type: 'pop',
      place: { kind: 'covered' },
    });
  });

  it('leaves every other link to the router', () => {
    expect(titleLinkAction(undefined, root([]))).toEqual({ type: 'open' });
    const settings: LinkState = {
      routes: [{ name: '(app)', state: { routes: [{ name: 'settings' }] } }],
    };
    expect(titleLinkAction(settings, root([{ name: 'index' }]))).toEqual({ type: 'open' });
  });
});
