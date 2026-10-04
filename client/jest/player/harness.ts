import type { EngineKind } from '@/player/engines/types';
import type { ControllerOptions, PlaybackController } from '@/player/controller';

import { FakeServer } from './fake-server';
import { ScriptedEngine } from './scripted-engine';

export { reply, FakeServer, type Reply } from './fake-server';
export { ScriptedEngine, type ScriptStep } from './scripted-engine';

/**
 * Real controller + scripted engines + fake server. Wire it in a test file with
 * `jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());`
 */
export const harness = {
  server: new FakeServer(),
  engines: [] as ScriptedEngine[],
  /** Engine features for the next engines (PiP, AirPlay). */
  features: {} as Partial<Pick<ScriptedEngine, 'supportsPictureInPicture' | 'supportsAirPlay'>>,
  get engine(): ScriptedEngine {
    const engine = this.engines.at(-1);
    if (!engine) throw new Error('no engine created yet');
    return engine;
  },
  reset(): void {
    this.server = new FakeServer();
    this.engines = [];
    this.features = {};
  },
};

export function enginesModule() {
  return {
    createEngine: (kind: EngineKind) => {
      const engine = Object.assign(new ScriptedEngine(kind), harness.features);
      harness.engines.push(engine);
      return engine;
    },
  };
}

let accounts = 0;

/** A controller on the fake server; `startSeconds` 0 skips the resume question unless overridden. */
export function newController(options: Partial<ControllerOptions> = {}): PlaybackController {
  // Required lazily: the controller imports the mocked engines module, which requires this file.
  const { PlaybackController: Controller } =
    require('@/player/controller') as typeof import('@/player/controller');
  accounts += 1;
  return new Controller({
    client: harness.server.client,
    accountId: `matrix${accounts}`,
    serverUrl: 'http://server',
    profile: {} as ControllerOptions['profile'],
    nativeEngine: 'expo-video',
    workId: 'w1',
    startSeconds: 0,
    ...options,
  });
}
