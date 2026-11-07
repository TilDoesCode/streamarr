import { Download, Pause, RotateCcw } from '@/components/icons';

/** The look of a download's main control on every screen; ▷ (Play) stays reserved for playing the file. */
export const DOWNLOAD_ACTION = {
  resume: { icon: Download, labelKey: 'downloads.detail.resume' },
  pause: { icon: Pause, labelKey: 'downloads.detail.pause' },
  retry: { icon: RotateCcw, labelKey: 'downloads.detail.retry' },
} as const;
