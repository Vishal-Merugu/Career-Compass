/**
 * Single source of truth for WebSocket events and payloads.
 */

export const ServerCommands = {
  SESSION_CHECK: 'SESSION_CHECK',
  FETCH_URL_BATCH: 'FETCH_URL_BATCH',
  SCRAPE_PROFILE: 'SCRAPE_PROFILE',
  STOP_LIMIT_REACHED: 'STOP_LIMIT_REACHED',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  REQUEST_STATE_SYNC: 'REQUEST_STATE_SYNC',
  ERROR: 'ERROR',
  FIND_EMAIL: 'FIND_EMAIL',
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
  EMAIL_FOUND: 'EMAIL_FOUND',
  EMAIL_FIND_FAILED: 'EMAIL_FIND_FAILED',
  CHECK_PENDING_EMAILS: 'CHECK_PENDING_EMAILS',
} as const;

// ─── Outbound Payload Interfaces (Server -> Extension) ──────────────────────

export interface FetchUrlBatchPayload {
  batchNumber: number;
  targetCount: number;
  searchUrl?: string;
}

export interface ScrapeProfilePayload {
  urlId: string;
  url: string;
}

export interface FindEmailPayload {
  urlId: string;
  url: string;
  firstName: string;
  lastName: string;
  companyName: string;
}

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

export interface EmailFoundPayload {
  jobId: string;
  urlId: string;
  email: string;
  source: string;
  validation: string;
}

export interface EmailFindFailedPayload {
  jobId: string;
  urlId: string;
  error: string;
}

export interface ErrorEventPayload {
  jobId: string;
  error: string;
}
