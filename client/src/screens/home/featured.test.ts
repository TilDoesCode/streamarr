import { FeaturedStore, type Featured } from './featured';

const item = (key: string, title = key): Featured => ({
  key,
  kind: 'movie',
  tmdbId: 1,
  title,
  eyebrow: 'Row',
});

describe('FeaturedStore', () => {
  it('lead features the first card and keeps it current until something else is featured', () => {
    jest.useFakeTimers();
    const store = new FeaturedStore();
    store.initial(item('top'));
    store.lead(item('a', 'Loading'));
    expect(store.get()?.title).toBe('Loading');
    store.lead(item('a', 'Loaded'));
    expect(store.get()?.title).toBe('Loaded');
    store.initial(item('other'));
    expect(store.get()?.key).toBe('a');
    store.set(item('b'));
    jest.runAllTimers();
    store.lead(item('a', 'Later'));
    expect(store.get()?.key).toBe('b');
    store.dispose();
    jest.useRealTimers();
  });
});
