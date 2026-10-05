import { VlcEngine } from '@/player/engines/vlc-engine';

import { FakeVlcView } from './library-fakes';
import { record } from './native';

/** VlcEngine with a view ref whose `getStats` answers `FakeVlcView.stats`; started at 10 s. */
export function vlcPlaying(options: ConstructorParameters<typeof VlcEngine>[0] = {}) {
  const engine = new VlcEngine(options);
  const internals = engine as unknown as {
    view: { current: unknown };
    onTime(seconds: number): void;
    setState(state: string): void;
  };
  internals.view.current = FakeVlcView.ref;
  engine.load({ uri: 'http://server/media.mkv', kind: 'progressive' });
  internals.onTime(0.5);
  internals.setState('playing');
  return { engine, internals, ...record(engine) };
}
