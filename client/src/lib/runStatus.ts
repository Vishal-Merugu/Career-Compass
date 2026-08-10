/**
 * How a run's status is worded and coloured, in one place.
 *
 * Shared by the Runs list and the run detail page so the same state cannot be
 * described two different ways on two screens.
 */

const COLORS: Record<string, string> = {
  initializing: 'gray',
  collecting_urls: 'blue',
  scraping: 'brand',
  completed: 'teal',
  paused_error: 'orange',
  // Distinct from paused_error: this one resumes by itself once the extension
  // pushes a fresh LinkedIn session.
  paused_session: 'yellow',
};

const LABELS: Record<string, string> = {
  initializing: 'starting',
  collecting_urls: 'finding people',
  scraping: 'reading profiles',
  completed: 'finished',
  paused_error: 'paused',
  paused_session: 'waiting for LinkedIn',
};

export function statusColor(status: string): string {
  return COLORS[status] ?? 'gray';
}

export function statusLabel(status: string): string {
  return LABELS[status] ?? status.replace(/_/g, ' ');
}

/** Statuses where work is still expected to move on its own. */
export const ACTIVE_STATUSES = new Set([
  'initializing',
  'collecting_urls',
  'scraping',
]);

/** Statuses the user can resume by hand. */
export const RESUMABLE_STATUSES = new Set(['paused_error', 'paused_session']);

/** Runs that will not progress without someone doing something. */
export function needsAttention(status: string): boolean {
  return RESUMABLE_STATUSES.has(status);
}
