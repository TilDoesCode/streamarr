import { releaseLaunchOrientation } from './launch-orientation';

describe('launch orientation (Q1-48)', () => {
  it('releases the lock on phones and tablets only', async () => {
    const unlockAsync = jest.fn(async () => undefined);
    const load = jest.fn(async () => ({ unlockAsync }));
    releaseLaunchOrientation(load, { os: 'ios', isTV: false });
    releaseLaunchOrientation(load, { os: 'android', isTV: false });
    releaseLaunchOrientation(load, { os: 'ios', isTV: true });
    releaseLaunchOrientation(load, { os: 'web', isTV: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(unlockAsync).toHaveBeenCalledTimes(2);
  });

  it('never throws when the module is missing', async () => {
    const load = jest.fn(() => Promise.reject(new Error('no native module')));
    expect(() => releaseLaunchOrientation(load, { os: 'ios', isTV: false })).not.toThrow();
    await Promise.resolve();
  });
});
