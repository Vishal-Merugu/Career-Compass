/**
 * Transient feedback for actions the user just took.
 *
 * `@mantine/notifications` was already installed and `<Notifications />` was
 * already mounted in `main.tsx` — with zero callers. Every action in the
 * dashboard reported itself by mutating a panel somewhere on the page, which
 * works for the ones that visibly change something and not at all for the ones
 * that do not: pausing a run, cancelling a queue, saving a draft, and stopping
 * a campaign all completed in total silence.
 *
 * **A toast is for the transient half of the story, never the whole of it.**
 * It disappears, so anything the user has to act on belongs in the page:
 *
 *   * A form's field-level error stays on the field.
 *   * `POST /api/jobs`'s 422 stays in `NewRunModal` — it carries a `fix` the
 *     user has to read and follow, and a message that vanishes in four seconds
 *     is not somewhere to put instructions.
 *   * `DeleteConfirmModal`'s receipt stays in the modal. It is the proof that
 *     the delete removed what it claimed to, and it is deliberately readable
 *     for as long as the user wants.
 *
 * So: toasts confirm, alerts instruct.
 */

import { notifications } from '@mantine/notifications';
import { ApiError } from '../api/client';

/** Long enough to read a sentence, short enough not to sit in the way. */
const DEFAULT_MS = 4_000;

/**
 * Errors get longer, because they are read rather than glanced at — and unlike
 * a success, the user usually has to do something about one.
 */
const ERROR_MS = 8_000;

interface ToastOptions {
  /** Bold first line. Omit for a single-line toast. */
  title?: string;
  /** Milliseconds on screen. `false` keeps it up until dismissed. */
  duration?: number | false;
  /**
   * Reuse this slot instead of stacking. Two presses of the same button should
   * replace one another, not queue up two identical toasts.
   */
  id?: string;
}

function show(
  color: string,
  message: string,
  { title, duration, id }: ToastOptions = {},
) {
  notifications.show({
    id,
    color,
    title,
    message,
    withCloseButton: true,
    withBorder: true,
    radius: 'md',
    autoClose: duration === undefined ? DEFAULT_MS : duration,
  });
}

export const toast = {
  /** It worked, and the result is visible elsewhere. */
  success: (message: string, options?: ToastOptions) =>
    show('teal', message, options),

  /** It failed. Longer by default — see `ERROR_MS`. */
  error: (message: string, options?: ToastOptions) =>
    show('red', message, { duration: ERROR_MS, ...options }),

  /** It worked, but not the way the user probably expected. */
  warning: (message: string, options?: ToastOptions) =>
    show('yellow', message, options),

  /** Neutral acknowledgement — something is now in progress. */
  info: (message: string, options?: ToastOptions) =>
    show('brand', message, options),
};

/**
 * The sentence to put in front of the user for a thrown error.
 *
 * `ApiError.message` is already the server's own wording from
 * `describeJobError` and friends, so it is used as-is. Anything else is a bug
 * or a browser-level failure, and its raw `message` is developer text — say
 * something true instead of leaking a stack-trace fragment into a toast.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}
