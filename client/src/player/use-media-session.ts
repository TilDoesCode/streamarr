import type { PlaybackController } from '@/player/controller';

/** Native players own the system controls (AVPlayer, Exo, VLC report them as engine events). */
export function useMediaSession(_controller: PlaybackController | null): void {}
