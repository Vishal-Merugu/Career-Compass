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

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  FindEmailsResponse,
  LookupProgress,
  LookupStatusResponse,
  ProfilesResponse,
} from '../api/types';

const LOOKUPS_KEY = ['email-lookups'];

export function useEmailLookups() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: LOOKUPS_KEY,
    queryFn: () => api.get<LookupStatusResponse>('/api/profiles/find-emails'),
    // A slow backstop only. The stream carries live updates; this catches the
    // case where the stream never connected — and stops once nothing is
    // pending, so an idle dashboard is not polling forever.
    refetchInterval: (q) =>
      (q.state.data?.stats.pending ?? 0) > 0 ? 15_000 : false,
  });

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
    onSuccess: (res) => {
      queryClient.setQueryData<LookupStatusResponse>(LOOKUPS_KEY, (prev) =>
        prev ? { ...prev, stats: res.stats } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      api.del<{ ok: true; cancelled: number }>('/api/profiles/find-emails'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LOOKUPS_KEY });
    },
  });

  return {
    stats: query.data?.stats,
    lookups: query.data?.lookups ?? [],
    pending,
    isLoading: query.isPending,
    findEmails,
    cancel,
  };
}
