import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SetupStatusResponse } from '../api/types';

/**
 * The three gates an account has to pass, shared by the checklist, the banner
 * and the New run form.
 *
 * Polled rather than fetched once: the LinkedIn gate is satisfied by opening
 * the Chrome extension, which happens in another window entirely, and a
 * checklist that needs a manual reload to notice is a checklist people stop
 * trusting.
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatusResponse>('/api/setup/status'),
    refetchInterval: 20_000,
    // The AI check makes a real network call to the model host, so this is not
    // free. Do not tighten the interval without a reason.
    staleTime: 10_000,
  });
}
