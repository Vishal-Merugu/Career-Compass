/**
 * Thin fetch wrapper for the CareerCompass API.
 *
 * Two things it guarantees:
 *
 * 1. `credentials: 'include'` on every request, so the httpOnly session cookie
 *    goes out. No token is ever held in JavaScript — see
 *    docs/adr/0004-same-origin-web-dashboard.md.
 * 2. Errors arrive as `ApiError` carrying the server's status and `errorCode`,
 *    so callers can branch on 401 without string-matching a message.
 */

/** Mirrors `ErrorCode` in `server/src/errors/AppError.ts`. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'LINKEDIN_SESSION_EXPIRED'
  | 'INTERNAL_ERROR'
  | 'WORKFLOW_RUNNING'
  | 'SERVER_RUN_DISABLED';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;

  constructor(message: string, status: number, code: ApiErrorCode | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface ErrorBody {
  error?: { message?: string; code?: ApiErrorCode };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // The session IS the cookie. Without this the browser omits it.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // The server is on the university network; a dropped VPN lands here.
    throw new ApiError(
      'Cannot reach the server. Is the VPN connected?',
      0,
      null,
    );
  }

  // The SPA fallback excludes /api and /health, so even a 404 from the API is
  // real JSON. An HTML body here means a proxy or a crashed server, not a
  // mistyped route — say so rather than dying inside JSON.parse.
  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!isJson) {
    throw new ApiError(
      `Unexpected non-JSON response (HTTP ${res.status})`,
      res.status,
      null,
    );
  }

  const body: unknown = await res.json();

  if (!res.ok) {
    const err = (body as ErrorBody).error;
    throw new ApiError(
      err?.message ?? `Request failed with HTTP ${res.status}`,
      res.status,
      err?.code ?? null,
    );
  }

  return body as T;
}

/**
 * Multipart upload.
 *
 * Deliberately does NOT go through `request`, which sets
 * `Content-Type: application/json` on every call. For a FormData body the
 * browser has to set that header itself — it appends the multipart boundary,
 * and a hand-written value omits it, so the server sees an unparseable body
 * and reports "no file was uploaded".
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(
      'Cannot reach the server. Is the VPN connected?',
      0,
      null,
    );
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  if (!isJson) {
    throw new ApiError(
      `Unexpected non-JSON response (HTTP ${res.status})`,
      res.status,
      null,
    );
  }

  const body: unknown = await res.json();
  if (!res.ok) {
    const err = (body as ErrorBody).error;
    throw new ApiError(
      err?.message ?? `Upload failed with HTTP ${res.status}`,
      res.status,
      err?.code ?? null,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
  put: <T>(path: string, payload?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload,
};
