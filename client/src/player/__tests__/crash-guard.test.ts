import {
  guardPlayback,
  installPlaybackCrashGuard,
  reportPlaybackError,
  resetPlaybackCrashGuard,
} from '../crash-guard';

type Handler = (error: unknown, isFatal?: boolean) => void;

describe('playback crash guard', () => {
  const scope = globalThis as { ErrorUtils?: unknown };
  const original = scope.ErrorUtils;
  let handler: Handler;
  let previous: jest.Mock;

  beforeEach(() => {
    resetPlaybackCrashGuard();
    previous = jest.fn();
    handler = previous;
    scope.ErrorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: Handler) => {
        handler = next;
      },
    };
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    scope.ErrorUtils = original;
    resetPlaybackCrashGuard();
    jest.restoreAllMocks();
  });

  it('leaves errors to the app handler while no playback runs', () => {
    installPlaybackCrashGuard();
    const error = new Error('outside');
    handler(error, true);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('hands a fatal error during playback to the player and never as fatal', () => {
    const sink = jest.fn();
    const release = guardPlayback(sink);
    const error = new TypeError('track list changed');
    handler(error, true);
    expect(sink).toHaveBeenCalledWith(error);
    // Dev builds list it non-fatal (jest runs with __DEV__); never the fatal path that ends the process.
    expect(previous).not.toHaveBeenCalledWith(error, true);
    release();
    handler(error, true);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('wraps thrown values that are not errors', () => {
    const sink = jest.fn();
    guardPlayback(sink);
    expect(reportPlaybackError('boom')).toBe(true);
    expect(sink.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((sink.mock.calls[0]![0] as Error).message).toBe('boom');
  });

  it('falls back to the app handler when the player itself fails', () => {
    guardPlayback(() => {
      throw new Error('sink broke');
    });
    const error = new Error('first');
    handler(error, true);
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it('routes to the newest player and installs only once', () => {
    const first = jest.fn();
    const second = jest.fn();
    guardPlayback(first);
    const wrapped = handler;
    const releaseSecond = guardPlayback(second);
    expect(handler).toBe(wrapped);
    handler(new Error('x'), false);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    releaseSecond();
    handler(new Error('y'), false);
    expect(first).toHaveBeenCalledTimes(1);
  });
});
