/** Every time budget of the player's recovery (state-matrix § 2 b.3 and § 2 c), in one place. */

/** Status timeline: spinner after 1 s of a stall, a hint after 4 s. */
export const SPINNER_MS = 1_000;
export const HINT_MS = 4_000;
/** A stall this long enters the ladder. */
export const STALL_LADDER_MS = 15_000;
/** No picture after `ready` this long: reload once, then the T7 ladder. */
export const START_BUDGET_MS = { progressive: 20_000, hls: 30_000 };
/** A server start state longer than this explains itself (E02); repairing follows its own ETA. */
export const STATE_BUDGET_MS: Record<string, number> = {
  queued: 60_000,
  resolving: 60_000,
  fallback: 60_000,
  planning: 30_000,
  starting: 45_000,
};
/** After a load, a seek or a track switch the watchdog waits this long before judging. */
export const SETTLE_MS = 2_000;
/** An engine `paused` the app did not ask for, held this long, is a pause by the system. */
export const SYSTEM_PAUSE_MS = 1_000;
/** The last seconds of a title (two HLS segments): an error, stall or verdict there ends the title. */
export const END_MARGIN_SECONDS = 12;

/** Healthy playback after which an incident and its budgets end. */
export const INCIDENT_RESET_MS = 120_000;
/** The viewer looks at a spinner at most this long per incident before the card (§ 2 c "≥ 60 s → G"). */
export const INCIDENT_STUCK_MS = 60_000;
/** The same failure starting this many incidents in this window goes straight to another way to play. */
export const RECURRING_INCIDENTS = 3;
export const RECURRING_WINDOW_MS = 15 * 60_000;
/** A running step without progress from the server this long fails with `step_timeout`. */
export const STEP_BUDGET_MS = 60_000;
/** No step runs longer than this, however much the server reports progress. */
export const STEP_MAX_MS = 5 * 60_000;
/** Offline longer than this gives up (the card retries on its own once online). */
export const OFFLINE_BUDGET_MS = 120_000;
/** Every incident ends on a card after this many steps; a wait with its own budget (signed out, server busy, another device, the system) ends on that. */
export const MAX_ATTEMPTS = 12;
/** Step-downs per incident: direct → remux → transcode → VLC at most. */
export const MAX_STEP_DOWNS = 3;
/** Waits between retries per category (seconds). */
export const T1_BACKOFF_S = [2, 4, 8, 16];
export const T4_BACKOFF_S = [5, 10, 20];
export const T6_BACKOFF_S = [5, 15];
/** Another device plays: one start every 10 s for two minutes, the only cap of that wait (B04). */
export const STREAM_POLL_S = 10;
export const STREAM_POLLS = 12;
export const MAX_QUALITY_STEPS = 2;

/** Automatic retries of a "connection lost" card when the network comes back, and how long it must stay back. */
export const AUTO_RETRIES = 3;
export const AUTO_RETRY_WINDOW_MS = 10 * 60_000;
export const ONLINE_SETTLE_MS = 2_000;
/** Quick seeks on a transcode collapse into one after this pause (D31). */
export const SEEK_DEBOUNCE_MS = 300;
/** A source that ends this long after its load without a picture had nothing to show (C31). */
export const EMPTY_END_MS = 1_000;
/** Failed subtitles come back on their own after this; one retry, then they stay off (C22). */
export const SUBTITLE_RETRY_MS = 60_000;
export const SUBTITLE_RETRIES = 1;
/** A resume prompt open this long checks that the server still has the playback. */
export const RESUME_REVALIDATE_MS = 60_000;
/** A retry inside the engine this recent explains a stall: the server failed, not the bandwidth (R7). */
export const LOAD_RETRY_RECENT_MS = 20_000;
/** A reload that shows no picture while its sound requests fail again is judged this soon, not at the start budget (S9c D36). */
export const AUDIO_RELOAD_MS = 10_000;
/** AVPlayer stopped itself in a stall: it is asked to play again after this, unless a system pause came meanwhile (D19). */
export const STALL_NUDGE_MS = 500;
