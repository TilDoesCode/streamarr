import { railSelect, type RailTabsState } from './rail-select';

const tabs = (active: number, stacks: Record<string, number> = {}): RailTabsState => ({
  index: active,
  routes: ['(home)', '(search)', '(movies)'].map((name) => ({
    name,
    state:
      name in stacks
        ? {
            key: `stack-${name}`,
            index: stacks[name],
            routes: [{ name: 'index' }, { name: 'movie/[id]' }],
          }
        : undefined,
  })),
});

describe('railSelect (TV rail)', () => {
  it('Home chosen on a Home detail pops Home to its first screen and goes to its top', () => {
    expect(railSelect(tabs(0, { '(home)': 2 }), '(home)')).toEqual({
      actions: [{ type: 'POP_TO_TOP', target: 'stack-(home)' }],
      reselect: true,
    });
  });

  it('the active tab on its first screen only goes back to its top', () => {
    expect(railSelect(tabs(0, { '(home)': 0 }), '(home)')).toEqual({ actions: [], reselect: true });
    expect(railSelect(tabs(2), '(movies)')).toEqual({ actions: [], reselect: true });
  });

  it('another tab opens on its first screen: a detail left open in its stack is dropped', () => {
    expect(railSelect(tabs(2, { '(home)': 1 }), '(home)')).toEqual({
      actions: [
        { type: 'JUMP_TO', payload: { name: '(home)' } },
        { type: 'POP_TO_TOP', target: 'stack-(home)' },
      ],
      reselect: false,
    });
  });

  it('finds the stack inside the single-route state expo-router wraps it in', () => {
    const wrapped: RailTabsState = {
      index: 0,
      routes: [
        {
          name: '(home)',
          state: {
            key: 'wrapper',
            index: 0,
            routes: [
              {
                name: '(home)',
                state: {
                  key: 'stack',
                  index: 1,
                  routes: [{ name: 'index' }, { name: 'movie/[id]' }],
                },
              },
            ],
          },
        },
      ],
    };
    expect(railSelect(wrapped, '(home)').actions).toEqual([
      { type: 'POP_TO_TOP', target: 'stack' },
    ]);
  });

  it('another tab without a stack yet (never visited) just switches', () => {
    expect(railSelect(tabs(0), '(search)')).toEqual({
      actions: [{ type: 'JUMP_TO', payload: { name: '(search)' } }],
      reselect: false,
    });
  });
});
