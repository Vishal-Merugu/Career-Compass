/**
 * Single source of truth for WebSocket events and payloads.
 */

// FETCH_URL_BATCH and SCRAPE_PROFILE are gone: URL collection and profile
// scraping run on the server, which holds the cookie jar the extension pushes
// to it. See docs/adr/0007-server-side-linkedin-calls.md.
export const ServerCommands = {
  SESSION_CHECK: 'SESSION_CHECK',
  STOP_LIMIT_REACHED: 'STOP_LIMIT_REACHED',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  REQUEST_STATE_SYNC: 'REQUEST_STATE_SYNC',
  ERROR: 'ERROR',
} as const;

export const ClientEvents = {
  REGISTER: 'REGISTER',
  URL_BATCH_ITEM: 'URL_BATCH_ITEM',
  URL_BATCH_COMPLETE: 'URL_BATCH_COMPLETE',
  PROFILE_SCRAPED: 'PROFILE_SCRAPED',
  PROFILE_SCRAPE_FAILED: 'PROFILE_SCRAPE_FAILED',
  SESSION_VALID: 'SESSION_VALID',
  SESSION_INVALID: 'SESSION_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  TAB_CLOSED: 'TAB_CLOSED',
  HEARTBEAT: 'HEARTBEAT',
} as const;

// ─── Outbound Payload Interfaces (Server -> Extension) ──────────────────────

// There is deliberately no FIND_EMAIL command. Email lookups are pulled by the
// extension over REST, not pushed down this socket: the handshake requires a
// live SearchJob (see middleware/auth.ts) and an MV3 service worker is killed
// after ~30s idle, so between jobs there is no socket to push anything down.
// See docs/adr/0006-email-lookup-queue.md.

export interface ErrorPayload {
  message: string;
  code?: string;
}

export interface RequestStateSyncPayload {
  jobId: string;
  nextAction: 'collect_urls' | 'scrape_profile' | 'completed' | 'paused';
}

// ─── Inbound Payload Interfaces (Extension -> Server) ───────────────────────

export interface RegisterPayload {
  jobId: string;
  userId: string;
  cachedLocalState?: {
    lastScrapedUrlId?: string;
    collectedCount?: number;
  };
}

export interface UrlBatchItemPayload {
  jobId: string;
  batchNumber: number;
  url: string;
  previewData?: {
    name?: string;
    headline?: string;
    location?: string;
  };
}

export interface UrlBatchCompletePayload {
  jobId: string;
  batchNumber: number;
  count: number;
}

export interface ProfileScrapedPayload {
  jobId: string;
  urlId: string;
  rawData: {
    name: string;
    headline?: string;
    location?: string;
    summary?: string;
    experience?: any[];
    education?: any[];
    skills?: any[];
    [key: string]: any;
  };
}

export interface ProfileScrapeFailedPayload {
  jobId: string;
  urlId: string;
  error: string;
  isPermanent: boolean; // true for private profile, false for timeout/retryable
}

export interface ErrorEventPayload {
  jobId: string;
  error: string;
}
