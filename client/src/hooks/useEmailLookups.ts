/**
 * Email-lookup queue state for the Results screen.
 *
 * Two sources, deliberately layered:
 *
 *   * `GET /api/profiles/find-emails` is the record. It is correct after a
 *     reload, after a server restart, and with no stream connected at all.
 *   * The SSE stream is an accelerator that pushes the same numbers sooner.
 *
 * That ordering matters because the work is done by a Chrome extension that may
 * be closed — progress can advance while nothing is watching, so the UI cannot
 * treat a stream frame as the only way state changes.
 */

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { toast } from '../lib/toast';
import type {
  FindEmailsResponse,
  LookupHandoffResponse,
  LookupProgress,
  LookupResumeResponse,
  LookupStatusResponse,
  ProfilesResponse,
} from '../api/types';

const LOOKUPS_KEY = ['email-lookups'];

/**
 * The queue record on its own, with no stream and no mutations.
 *
 * Split out for the sidebar indicator, which has to know a lookup is running
 * from any screen. React Query dedupes it against the Results page's copy, so
 * mounting both is one request — but only `useEmailLookups` opens the
 * EventSource, and two of those would be two server connections.
 */
export function useLookupQueue() {
  return useQuery({
    queryKey: LOOKUPS_KEY,
    queryFn: () => api.get<LookupStatusResponse>('/api/profiles/find-emails'),
    // A slow backstop only. The stream carries live updates; this catches the
    // case where the stream never connected — and stops once nothing is
    // pending, so an idle dashboard is not polling forever.
    //
    // A fully stalled queue backs off: it is waiting on the user opening Chrome,
    // which is not a thing that changes on a fifteen-second cadence, and it can
    // stay that way for hours.
    refetchInterval: (q) => {
      const stats = q.state.data?.stats;
      if (!stats || stats.pending === 0) return false;
      return stats.stalled >= stats.pending ? 60_000 : 15_000;
    },
  });
}

export function useEmailLookups() {
  const queryClient = useQueryClient();

  const query = useLookupQueue();

  const pending = query.data?.stats.pending ?? 0;
  // A boolean, not the count. Depending on `pending` itself re-ran this effect
  // on every progress frame, closing and reopening the EventSource once per
  // lookup — about 80 reconnects for a 40-profile run.
  const hasPending = pending > 0;

  useEffect(() => {
    // Only hold a stream open while there is something to report.
    if (!hasPending) return;

    const source = new EventSource('/api/profiles/find-emails/events', {
      withCredentials: true,
    });

    source.onmessage = (event: MessageEvent<string>) => {
      let frame: LookupProgress;
      try {
        frame = JSON.parse(event.data) as LookupProgress;
      } catch {
        return;
      }

      if (frame.stats) {
        queryClient.setQueryData<LookupStatusResponse>(LOOKUPS_KEY, (prev) =>
          prev && frame.stats ? { ...prev, stats: frame.stats } : prev,
        );
      }

      // The row's own queue entry has to move too, not just the counters.
      // `lookups` is what the Email column reads to decide a row is still
      // being worked — patching only `stats` left a finished row holding a
      // `queued`/`dispatched` entry, so the spinner kept running next to the
      // address that had just arrived. The backstop poll does not clear it
      // either: it stops the moment `stats.pending` hits 0, which is the same
      // frame that finished the last row.
      if (frame.type === 'ITEM' && frame.lookupId) {
        if (frame.status === 'done') {
          queryClient.setQueryData<LookupStatusResponse>(LOOKUPS_KEY, (prev) =>
            prev
              ? {
                  ...prev,
                  lookups: prev.lookups.map((l) =>
                    l.id === frame.lookupId
                      ? {
                          ...l,
                          status: 'done',
                          email: frame.email ?? l.email,
                          emailSource: frame.emailSource ?? l.emailSource,
                          emailValidation:
                            frame.emailValidation ?? l.emailValidation,
                          completedAt: new Date().toISOString(),
                        }
                      : l,
                  ),
                }
              : prev,
          );
        } else {
          // A miss is `failed` on the wire whether the row is exhausted or
          // going back in the queue for another attempt, and only the server
          // knows which. Ask it rather than guessing a terminal state.
          void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
        }
      }

      // A found address changes a row in the profiles table, which is a
      // different query. Patch it in place rather than refetching every page
      // that has been loaded.
      if (frame.type === 'ITEM' && frame.profileId && frame.email) {
        queryClient.setQueriesData<{ pages: ProfilesResponse[] }>(
          { queryKey: ['profiles'] },
          (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              pages: prev.pages.map((page) => ({
                ...page,
                profiles: page.profiles.map((p) =>
                  p.id === frame.profileId
                    ? {
                        ...p,
                        email: frame.email ?? p.email,
                        emailSource: frame.emailSource ?? p.emailSource,
                        emailValidation:
                          frame.emailValidation ?? p.emailValidation,
                      }
                    : p,
                ),
              })),
            };
          },
        );
      }
    };

    // EventSource reconnects on its own; what it cannot recover is state that
    // changed while it was away, so refetch the record on every error.
    source.onerror = () => {
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    };

    return () => source.close();
  }, [hasPending, queryClient]);

  // When the last lookup finishes, the headline tiles ("With an email") are
  // stale — they are computed server-side over the whole result set, so no
  // amount of row patching updates them.
  useEffect(() => {
    if (!hasPending && query.data) {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    }
  }, [hasPending, query.data, queryClient]);

  // The queue list itself is resynced once at the end of a batch, because the
  // backstop poll stops on the same frame that empties the queue — anything
  // that finished without a `done` frame (dropped stream, a lease the sweeper
  // reclaimed, a cancel) would otherwise keep its badge until a reload.
  //
  // Guarded on the true→false edge, not on `hasPending`: invalidating on the
  // level would refetch, produce new `query.data`, and invalidate again.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !hasPending) {
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    }
    wasPending.current = hasPending;
  }, [hasPending, queryClient]);

  const findEmails = useMutation({
    mutationFn: (vars: {
      profileIds: string[];
      force?: boolean;
      /**
       * Allow the server to settle these with patterns + SMTP if no browser
       * turns up. Off unless asked: the provider lookup only works in the
       * extension, and a server pass bottoms out at a guess.
       */
      serverFallback?: boolean;
    }) => api.post<FindEmailsResponse>('/api/profiles/find-emails', vars),
    // The Results screen renders `findEmails.error` in a dismissible Alert
    // above the table, next to the progress panel it belongs with.
    meta: { silenceErrorToast: true },
    onSuccess: (res) => {
      // Queuing nothing is the surprising outcome, and it is silent otherwise:
      // the progress panel only appears when there is something in flight, so
      // "every one you picked already had a verified address" looked exactly
      // like the button doing nothing.
      if (res.queued === 0) {
        toast.warning(
          res.skippedVerified > 0
            ? `Nothing queued — all ${res.skippedVerified} already had a verified address.`
            : 'Nothing queued. These profiles have no company domain to search against.',
        );
      } else {
        toast.info(
          `Looking up ${res.queued} ${res.queued === 1 ? 'address' : 'addresses'}. Progress is saved, so you can leave this tab.`,
        );
      }
      queryClient.setQueryData<LookupStatusResponse>(LOOKUPS_KEY, (prev) =>
        prev ? { ...prev, stats: res.stats } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  /**
   * Clear a LinkFinder pause and start the pass again.
   *
   * Only ever user-initiated. The server cannot see a topped-up balance or an
   * expired rate-limit window, so nothing here resumes on a timer — that would
   * be a slower way of hitting the same wall with the user's credits.
   */
  const resumeLinkFinder = useMutation({
    mutationFn: () =>
      api.post<LookupResumeResponse>('/api/profiles/find-emails/resume', {}),
    onSuccess: (res) => {
      toast.success(
        `LinkFinder resumed. ${res.stats.queued} ${res.stats.queued === 1 ? 'lookup' : 'lookups'} back in the queue.`,
      );
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  /**
   * Release the rows LinkFinder missed to the extension's browser waterfall.
   *
   * The second manual gate. That path spends a real browser and about 30s per
   * profile in a tab the user is looking at, so it is entered on purpose.
   */
  const pushToExtension = useMutation({
    mutationFn: () =>
      api.post<LookupHandoffResponse>('/api/profiles/find-emails/handoff', {}),
    onSuccess: (res) => {
      toast.info(
        res.released === 0
          ? 'Nothing was waiting to be sent.'
          : `${res.released} ${res.released === 1 ? 'lookup' : 'lookups'} sent to the extension. Open Chrome with it signed in to work them.`,
      );
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      api.del<{ ok: true; cancelled: number }>('/api/profiles/find-emails'),
    onSuccess: (res) => {
      toast.success(
        `${res.cancelled} queued ${res.cancelled === 1 ? 'lookup' : 'lookups'} cancelled. Anything already in flight finishes.`,
      );
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  return {
    stats: query.data?.stats,
    linkFinder: query.data?.linkFinder,
    lookups: query.data?.lookups ?? [],
    pending,
    isLoading: query.isPending,
    findEmails,
    cancel,
    resumeLinkFinder,
    pushToExtension,
  };
}
