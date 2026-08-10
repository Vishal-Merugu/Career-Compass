import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { LoginResponse, MeResponse, User } from '../api/types';

/**
 * Session state, derived entirely from `GET /api/auth/me`.
 *
 * There is deliberately nothing to read locally: the session lives in an
 * httpOnly cookie that JavaScript cannot see, so the only way to know whether
 * we are logged in is to ask the server. A 401 means logged out — that is the
 * expected answer on first load, not an error worth reporting.
 */
interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /**
   * `registrationToken` is only required once the server already has an
   * account; the first registration on an empty database is always allowed.
   * See `assertMayRegister` in `server/src/auth/routes.ts`.
   */
  register: (
    email: string,
    password: string,
    registrationToken?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // `null` is a real value here, not "not loaded yet": it is how logout and any
  // 401 record "definitely signed out" without waiting for a round trip.
  const { data, isLoading } = useQuery<MeResponse | null>({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
    // A 401 is a legitimate answer here, so it must not be retried or it costs
    // three round trips before the login screen appears.
    retry: (_count, error) =>
      !(error instanceof ApiError && error.isUnauthorized),
    // Signed out is a valid resolved state, not a failure to surface.
    throwOnError: false,
    staleTime: 5 * 60 * 1000,
  });

  const loginMutation = useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api.post<LoginResponse>('/api/auth/login', vars),
    // The sign-in form renders the failure itself, under the fields it is
    // about — "wrong password" belongs next to the password box, and a toast
    // in the corner of an otherwise-empty login screen is the wrong place for
    // the only thing on it that matters.
    meta: { silenceErrorToast: true },
    onSuccess: (res) => {
      // The response also carries `token`; ignored on purpose — the cookie the
      // server just set is the session. See ADR 0004.
      queryClient.setQueryData(ME_QUERY_KEY, {
        ok: true,
        user: res.user,
      } satisfies MeResponse);
    },
  });

  const login = useCallback(
    async (email: string, password: string) => {
      await loginMutation.mutateAsync({ email, password });
    },
    [loginMutation],
  );

  const registerMutation = useMutation({
    mutationFn: (vars: {
      email: string;
      password: string;
      registrationToken?: string;
    }) => api.post<LoginResponse>('/api/auth/register', vars),
    // Same reasoning as login — an invite-code rejection has to stay next to
    // the invite-code field.
    meta: { silenceErrorToast: true },
    onSuccess: (res) => {
      // Register signs you straight in — the server sets the same session
      // cookie it sets on login, so there is no second round trip.
      queryClient.setQueryData(ME_QUERY_KEY, {
        ok: true,
        user: res.user,
      } satisfies MeResponse);
    },
  });

  const register = useCallback(
    async (email: string, password: string, registrationToken?: string) => {
      await registerMutation.mutateAsync({
        email,
        password,
        // Send the field only when filled, so an empty box is not mistaken
        // for an attempt at the wrong token.
        registrationToken: registrationToken?.trim() || undefined,
      });
    },
    [registerMutation],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Write the signed-out state explicitly, even if the call failed — the
      // user asked to be signed out, and a stale cached user is worse than an
      // extra 401.
      //
      // This used to be `queryClient.clear()`, which evicts the cache but
      // neither resets an actively-subscribed observer's `data` nor triggers a
      // refetch. `user` stayed truthy, so /login bounced straight back to
      // /results and the user was left on a 401'd page still showing their own
      // email in the header. Setting the value is unambiguous; evicting is not.
      queryClient.setQueryData(ME_QUERY_KEY, null);
      // Drop everything else so the next account cannot see the last one's data.
      queryClient.removeQueries({
        predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0],
      });
    }
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({ user: data?.user ?? null, isLoading, login, register, logout }),
    [data, isLoading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
