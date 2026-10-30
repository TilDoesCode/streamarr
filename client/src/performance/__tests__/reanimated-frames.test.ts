// The patched UI-thread run loop (patches/react-native-reanimated, react-native-worklets): frames only while work waits,
// and every animated-prop update still reaches the views. The registry runs as on native (not Jest's shortcut).

type Global = typeof globalThis & {
  __mapperRegistry?: unknown;
  __requestMapperRunFinalizer: (finalizer: () => void) => void;
  __mapperRun: () => void;
  requestAnimationFrameFinalizer: (callback: () => void) => void;
};

function nativeRegistry() {
  const microtasks: (() => void)[] = [];
  const frameFinalizers: (() => void)[] = [];
  const g = globalThis as Global;
  delete g.__mapperRegistry;
  jest.resetModules();
  jest.doMock('react-native-worklets', () => ({ scheduleOnUI: (job: () => void) => job() }));
  jest.doMock('react-native-reanimated/src/common', () => ({
    IS_JEST: false,
    SHOULD_BE_USE_WEB: false,
  }));
  const queueMicrotask = jest.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => {
    microtasks.push(task);
  });
  g.requestAnimationFrameFinalizer = (callback) => void frameFinalizers.push(callback);
  const { startMapper } = jest.requireActual<{
    startMapper: (worklet: () => void, inputs: unknown[]) => number;
  }>('react-native-reanimated/src/mappers');
  startMapper(() => undefined, []);
  // A UI job drains the microtasks it queued (JSIWorkletsModuleProxy::scheduleOnUI).
  const drain = () => {
    while (microtasks.length) microtasks.shift()!();
  };
  /** One native frame: callbacks, then microtasks, then frame finalizers (worklets executeQueue). */
  const frame = () => {
    drain();
    const finalizers = frameFinalizers.splice(0);
    for (const finalizer of finalizers) finalizer();
  };
  drain();
  frame();
  return { g, drain, frame, frameFinalizers, restore: () => queueMicrotask.mockRestore() };
}

afterEach(() => {
  jest.dontMock('react-native-worklets');
  jest.dontMock('react-native-reanimated/src/common');
});

describe('Reanimated mapper runs without the endless frame loop', () => {
  it('flushes prop updates made outside a mapper run (a withTiming stepped by its own frame: player overlay fade)', () => {
    const { g, drain, restore } = nativeRegistry();
    const flush = jest.fn();
    g.__requestMapperRunFinalizer(flush);
    drain();
    expect(flush).toHaveBeenCalledTimes(1);
    restore();
  });

  it('asks for a frame so a request from an event handler (no microtask drain) runs at the latest one frame later', () => {
    const { g, frame, frameFinalizers, restore } = nativeRegistry();
    const flush = jest.fn();
    g.__requestMapperRunFinalizer(flush);
    expect(frameFinalizers.length).toBeGreaterThan(0);
    frame();
    expect(flush).toHaveBeenCalledTimes(1);
    restore();
  });

  it('asks for nothing while idle', () => {
    const { frameFinalizers, restore } = nativeRegistry();
    expect(frameFinalizers).toHaveLength(0);
    restore();
  });
});
