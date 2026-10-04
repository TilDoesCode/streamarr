import { redirectSystemPath } from '@/app/+native-intent';

const mockDispatch = jest.fn();
const mockNavigate = jest.fn();
const mockPopToScreen = jest.fn();
let mockRoot: object = {};

jest.mock('expo-router', () => ({ router: { navigate: (href: string) => mockNavigate(href) } }));
jest.mock('expo-router/build/global-state/router-store', () => ({
  store: {
    linking: {
      config: {},
      getStateFromPath: (path: string) => ({
        routes: [
          {
            name: '(home)',
            state: {
              routes: [
                { name: 'index' },
                { name: 'movie/[id]', params: { id: path.split('/')[2] } },
              ],
            },
          },
        ],
      }),
    },
    navigationRef: {
      getRootState: () => mockRoot,
      dispatch: (action: object) => mockDispatch(action),
    },
  },
}));
jest.mock('@modules/tv-native', () => ({
  popToScreen: (testID: string) => mockPopToScreen(testID),
}));

const home = (...ids: string[]) => ({
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

beforeEach(() => {
  mockDispatch.mockClear();
  mockNavigate.mockClear();
  mockPopToScreen.mockReset();
});

describe('redirectSystemPath (I4 item 8)', () => {
  it('passes a new title and the launch link through to the router', () => {
    mockRoot = home('1');
    expect(redirectSystemPath({ path: 'streamarr:///movie/2', initial: false })).toBe(
      'streamarr:///movie/2'
    );
    expect(redirectSystemPath({ path: 'streamarr:///movie/1', initial: true })).toBe(
      'streamarr:///movie/1'
    );
  });

  it('keeps a link to the title on top without a second copy', () => {
    mockRoot = home('1');
    expect(redirectSystemPath({ path: 'streamarr:///movie/1', initial: false })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('pops back to an open title in JS where the native stack is not involved', () => {
    mockRoot = home('1', '2', '3');
    mockPopToScreen.mockReturnValue(null);
    expect(redirectSystemPath({ path: 'streamarr:///movie/1', initial: false })).toBeNull();
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'POP',
      payload: { count: 2 },
      target: 'home-stack',
    });
  });

  it('pops the native stack on Apple TV (a JS pop drops linked pages there)', async () => {
    mockRoot = home('1', '2');
    mockPopToScreen.mockReturnValue(Promise.resolve(true));
    expect(redirectSystemPath({ path: 'streamarr:///movie/1', initial: false })).toBeNull();
    expect(mockPopToScreen).toHaveBeenCalledWith('movie-screen-1');
    await Promise.resolve();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
