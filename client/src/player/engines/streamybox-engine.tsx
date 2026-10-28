import { View } from 'react-native';

import { EngineBase } from './base';
import type { EngineSource, PlayerEngine, SurfaceProps } from './types';

/** Streamybox embedded player (dev.streamybox.player renders mpv into Streamarr's surface). */
export class StreamyboxEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'streamybox' as const;
  readonly Surface = ({ style }: SurfaceProps) => <View style={style} />;

  load(source: EngineSource): void {
    this.resetForLoad(source);
  }
  play(): void {}
  pause(): void {}
  seek(_position: number): void {}
  setAudioTrack(_id: string): void {}
  setSubtitleTrack(_id: string | null): void {}
}
