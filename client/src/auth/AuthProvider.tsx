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
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
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

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Clear local state even if the call failed — the user asked to be
      // signed out, and a stale cached user is worse than an extra 401.
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({ user: data?.user ?? null, isLoading, login, logout }),
    [data, isLoading, login, logout],
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
