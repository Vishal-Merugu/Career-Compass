/**
 * Response shapes for the endpoints the dashboard consumes.
 *
 * Hand-written rather than generated: the server owns the Prisma types, and
 * importing across the `server/` ↔ `client/` boundary would drag Node-only types
 * into a browser build. Keep these in sync with `server/prisma/schema.prisma` and
 * the routers under `server/src/api/`.
 */

export interface User {
  id: string;
  email: string;
  apiKey?: string;
  telegramId?: string | null;
}

export interface Company {
  id: string;
  companyId: string;
  name: string;
  slug: string | null;
  employeeCount: number | null;
  industry: string | null;
  website: string | null;
}

export interface Profile {
  id: string;
  profileId: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string;
  email: string | null;
  emailSource: string | null;
  emailValidation: string | null;
  createdAt: string;
  company: Company | null;
}

/** `POST /api/auth/login` — `token` is present but the dashboard ignores it. */
export interface LoginResponse {
  ok: true;
  user: User;
}

export interface MeResponse {
  ok: true;
  user: User;
}

/**
 * `GET /api/profiles?skip&take`.
 *
 * `stats` is computed server-side over the entire result set, not the page in
 * `profiles`. The headline tiles read from it so they stay correct however many
 * pages have been loaded.
 */
export interface ProfilesResponse {
  ok: true;
  profiles: Profile[];
  skip: number;
  take: number;
  total: number;
  stats: {
    total: number;
    withEmail: number;
    companies: number;
  };
}

// ─── Email lookups ───────────────────────────────────────────────

export type LookupStatus = 'queued' | 'dispatched' | 'done' | 'failed';

/** Mirrors `LookupStats` in `server/src/services/emailLookup.service.ts`. */
export interface LookupStats {
  queued: number;
  dispatched: number;
  done: number;
  failed: number;
  /** queued + dispatched — what the UI calls "still working". */
  pending: number;
  /**
   * Pending rows waiting on a browser that is not there: queued past the
   * extension's grace period with no server fallback. Rendered as "waiting",
   * never as a spinner.
   */
  stalled: number;
  /**
   * Rows LinkFinder ran and missed, now waiting on a person.
   *
   * Not stalled and not failed — the API does not know them, the extension's
   * browser waterfall might, and entering that path costs a real browser and
   * the user's time. The panel offers a "Send to extension" button for these
   * rather than a spinner.
   */
  heldForHandoff: number;
  total: number;
  /**
   * The batch these counts cover — one press of "Find emails". Counts are
   * scoped to it (plus anything older still running), so the panel describes
   * the run you just started rather than every lookup the account has done.
   */
  batchId: string | null;
}

/** Mirrors `LinkFinderPauseCode` in `linkFinderAccount.service.ts`. */
export type LinkFinderPauseCode = 'no_credits' | 'rate_limited' | 'bad_key';

/**
 * Mirrors `LinkFinderState`. Never carries the key — `configured` is the only
 * thing the client learns about it.
 */
export interface LinkFinderState {
  configured: boolean;
  paused: boolean;
  pauseCode: LinkFinderPauseCode | null;
  /** Ready-to-render copy for `pauseCode`, or null when running. */
  title: string | null;
  message: string | null;
  /** The provider's own words. Render collapsed, never as the headline. */
  detail: string | null;
  pausedAt: string | null;
}

export interface EmailLookup {
  id: string;
  profileId: string;
  status: LookupStatus;
  attempts: number;
  /** Which executor took it: `extension` or `server`. */
  claimedBy: string | null;
  email: string | null;
  emailSource: string | null;
  emailValidation: string | null;
  lastError: string | null;
  requestedAt: string;
  /** When the current lease was taken. Null unless `status` is `dispatched`. */
  dispatchedAt: string | null;
  /** Whether an unclaimed row may fall through to the server-side finder. */
  allowServerFallback: boolean;
  /**
   * LinkFinder missed this one and it is parked, waiting on the user to send
   * it to the extension. No executor can claim it until they do.
   */
  pendingHandoff: boolean;
  completedAt: string | null;
}

export interface FindEmailsResponse {
  ok: true;
  queued: number;
  /** The batch these were queued as. */
  batchId: string;
  skippedVerified: number;
  skippedUnknown: number;
  stats: LookupStats;
  linkFinder: LinkFinderState;
}

export interface LookupStatusResponse {
  ok: true;
  stats: LookupStats;
  linkFinder: LinkFinderState;
  lookups: EmailLookup[];
}

/** `POST /api/profiles/find-emails/resume`. */
export interface LookupResumeResponse {
  ok: true;
  stats: LookupStats;
  linkFinder: LinkFinderState;
}

/** `POST /api/profiles/find-emails/handoff`. */
export interface LookupHandoffResponse {
  ok: true;
  released: number;
  stats: LookupStats;
  linkFinder: LinkFinderState;
}

/** One frame of `GET /api/profiles/find-emails/events`. */
export interface LookupProgress {
  userId: string;
  type: 'ITEM' | 'STATS';
  lookupId?: string;
  profileId?: string;
  status?: LookupStatus;
  email?: string | null;
  emailSource?: string | null;
  emailValidation?: string | null;
  error?: string | null;
  stats?: LookupStats;
}

// ─── Settings ────────────────────────────────────────────────────

/** Mirrors `JobErrorCode` in `server/src/errors/jobErrors.ts`. */
export type JobErrorCode =
  | 'LLM_UNREACHABLE'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMIT'
  | 'LLM_QUOTA'
  | 'LLM_BAD_JSON'
  | 'SESSION_MISSING'
  | 'SESSION_EXPIRED'
  | 'LINKEDIN_RATE_LIMIT'
  | 'COMPANY_NOT_FOUND'
  | 'NO_RESULTS'
  | 'SMTP_BLOCKED'
  | 'UNKNOWN';

export type LlmProvider =
  'server' | 'ollama' | 'gemini' | 'openrouter' | 'groq' | 'custom';

/**
 * One entry in the fallback chain — `GET /api/settings/ai/credentials`.
 *
 * The order of the array *is* the order the models are tried in. The key is
 * never included: `apiKeySet` is all the screen needs to know.
 */
export interface LlmCredential {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  priority: number;
  enabled: boolean;
  apiKeySet: boolean;
  /** `cooling` is temporary and ours; `disabled` needs the user to act. */
  status: 'ready' | 'cooling' | 'disabled' | 'off';
  cooldownUntil: string | null;
  disabledCode: string | null;
  lastErrorCode: string | null;
  lastUsedAt: string | null;
  successCount: number;
  failureCount: number;
}

export interface LlmCredentialsResponse {
  ok: true;
  credentials: LlmCredential[];
}

export interface LlmCredentialResponse {
  ok: true;
  credential: LlmCredential;
}

export interface LlmCredentialCheckResponse {
  ok: true;
  checkedFrom: 'server';
  check: PreflightCheck;
}

/** `GET/PUT /api/settings/ai`. The key itself is never sent. */
export interface AiSettings {
  llmProvider: LlmProvider;
  llmUrl: string;
  llmModel: string;
  llmApiKeySet: boolean;
  builtIn: { url: string; model: string };
}

export interface AiSettingsResponse {
  ok: true;
  settings: AiSettings;
}

/** `POST /api/settings/ai/check` — always performed by the server. */
export interface AiCheckResponse {
  ok: true;
  checkedFrom: 'server';
  reachable: boolean;
  url?: string;
  models: string[];
  check: PreflightCheck;
}

export interface FinderSettings {
  searchPrompt: string;
  usingDefaultPrompt: boolean;
  dailyLimit: number;
  emailFinderEnabled: boolean;
  userContext: string | null;
  /** Whether a LinkFinder key is saved. Never the key itself. */
  linkFinderApiKeySet: boolean;
  linkFinder: LinkFinderState;
}

/** `POST /api/settings/finder/linkfinder/check`. Spends one LinkFinder credit. */
export interface LinkFinderCheckResponse {
  ok: boolean;
  reason?: string;
  message: string;
  detail?: string | null;
}

export interface FinderSettingsResponse {
  ok: true;
  settings: FinderSettings;
}

/** One gate, from `preflightJob` on the server. */
export interface PreflightCheck {
  ok: boolean;
  code?: JobErrorCode;
  message?: string;
  fix?: string;
  detail?: string;
}

export interface SetupStatusResponse {
  ok: true;
  setup: {
    aiModel: PreflightCheck;
    linkedinSession: PreflightCheck;
    outreachEmail: PreflightCheck & { optional: true };
    readyToRun: boolean;
  };
}

/** `GET /api/settings/telegram`. */
export interface TelegramStatusResponse {
  ok: true;
  telegram: { linked: boolean; botConfigured: boolean };
}

/** `POST /api/settings/telegram/code` — single use, short lived. */
export interface TelegramCodeResponse {
  ok: true;
  code: string;
  expiresInSeconds: number;
}

/** `GET /api/profiles/:id` — the fields the list payload deliberately omits. */
export interface ProfileDetailResponse {
  ok: true;
  profile: Profile & {
    about: string | null;
    qualificationReason: string | null;
    searchJobId: string | null;
  };
}

/** `GET /api/session`. Cookie values are never included. */
export interface LinkedInSessionState {
  present: boolean;
  isValid: boolean;
  invalidReason: string | null;
  importedAt: string | null;
  lastChecked: string | null;
  missingCritical: string[];
}

export interface SessionResponse {
  ok: true;
  session: LinkedInSessionState;
}

export interface PreflightResponse {
  ok: true;
  preflight: {
    ok: boolean;
    checks: { linkedinSession: PreflightCheck; aiModel: PreflightCheck };
    code?: JobErrorCode;
    message?: string;
    fix?: string;
  };
}

// ─── Search jobs ─────────────────────────────────────────────────

/** What the server says went wrong, already written for a human. */
export interface JobFailure {
  message: string;
  fix: string;
}

/** `GET /api/jobs`. */
export interface SearchJob {
  id: string;
  status: string;
  limitRequested: number;
  qualifiedCount: number;
  currentBatchNumber: number;
  createdAt: string;
  searchParams: { companyUrl?: string; prompt?: string; batchSize?: number };
  totalUrls: number;
  failureCode: JobErrorCode | null;
  failureDetail: string | null;
  failure: JobFailure | null;
  configSnapshot: {
    llmProvider?: string;
    llmModel?: string;
    companyUrl?: string;
    limitRequested?: number;
    batchSize?: number;
  } | null;
}

/** `GET /api/jobs/:id/events`. */
export interface JobEvent {
  id: string;
  jobId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  stage: 'run' | 'collect' | 'scrape' | 'qualify' | 'publish' | 'email';
  code: string;
  message: string;
  detail: string | null;
  count: number;
  profileRef: string | null;
}

export interface JobEventsResponse {
  ok: true;
  events: JobEvent[];
}

/**
 * `GET /api/jobs?skip&take`.
 *
 * Paginated because each row on the Runs screen opens its own
 * `/jobs/:id/status` poll — the page size bounds how many pollers run at once,
 * not just how much JSON arrives.
 */
export interface JobsResponse {
  ok: true;
  jobs: SearchJob[];
  skip: number;
  take: number;
  total: number;
  /**
   * Counted over every run, not the page in `jobs` — same rule as `stats` on
   * `GET /api/profiles`. `needsAttention` is the one number on the Runs screen
   * meant to prompt an action, so a paused run on page 2 has to be in it.
   */
  stats: {
    total: number;
    active: number;
    needsAttention: number;
  };
}

/**
 * What a delete actually removed.
 *
 * Mirrors `DeletionSummary` in `server/src/services/dataDeletion.service.ts`.
 * Shown rather than swallowed: a destructive action that reports only
 * "deleted" looks identical to one that quietly did nothing, and the whole
 * point of this feature is that nothing is left behind.
 */
export interface DeletionSummary {
  runs: number;
  collectedUrls: number;
  scrapedProfiles: number;
  decisions: number;
  events: number;
  outreachLogs: number;
  profiles: number;
  emailLookups: number;
  companies: number;
  campaignContactsRemoved: number;
  campaignContactsKept: number;
}

export interface DeleteResponse {
  ok: true;
  deleted: DeletionSummary;
}

/** `GET /api/jobs/:id/status`. */
export interface JobStatusResponse {
  ok: true;
  job: {
    id: string;
    status: string;
    limitRequested: number;
    qualifiedCount: number;
    currentBatchNumber: number;
    createdAt: string;
    searchParams?: { companyUrl?: string; prompt?: string };
    failureCode: JobErrorCode | null;
    failureDetail: string | null;
    failure: JobFailure | null;
    configSnapshot: SearchJob['configSnapshot'];
  };
  stats: {
    collectedCount: number;
    scrapedCount: number;
    remainingCount: number;
    failedCount: number;
    /** The model answered "no". A result. */
    rejectedCount: number;
    /** The model never answered. Not a result — retryable on resume. */
    erroredCount: number;
    inFlightCount: number;
  };
  // There is deliberately no `decisions` array. It used to carry every
  // qualified profile — `rawData` and all — and no screen ever read it, while
  // the Runs list re-fetched it once per row every 3 s. The people a run found
  // are on Results, filtered by `?jobId=`, which is paginated.
}

// ─── Outreach ────────────────────────────────────────────────────

export type CampaignStatus =
  'PENDING' | 'SENDING' | 'COMPLETE' | 'STOPPED' | 'FAILED';

export type ContactStatus =
  'PENDING' | 'GENERATING' | 'SENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  emailSubject: string;
  fromName: string | null;
  commonPrompt: string | null;
  minDelayMs: number;
  maxDelayMs: number;
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Note there is no `sentBody`. The detail endpoint omits it — a full copy of
 * every email sent is a large payload no list screen renders.
 */
export interface CampaignContact {
  id: string;
  profileId: string | null;
  name: string;
  email: string;
  companyName: string | null;
  description: string | null;
  customSubject: string | null;
  customBody: string | null;
  status: ContactStatus;
  errorMessage: string | null;
  sentAt: string | null;
}

export interface CampaignsResponse {
  ok: true;
  campaigns: Campaign[];
  skip: number;
  take: number;
  total: number;
}

/**
 * `GET /api/campaigns/:id?skip&take`.
 *
 * `contacts` is one page. The stat tiles read `campaign.totalContacts` /
 * `sentCount` / `failedCount`, which the server maintains over the whole
 * campaign, so they stay right no matter which page is on screen —
 * `contactsTotal` is only there to drive the pager.
 */
export interface CampaignDetailResponse {
  ok: true;
  campaign: Campaign;
  contacts: CampaignContact[];
  skip: number;
  take: number;
  contactsTotal: number;
}

export interface AddContactsResponse {
  ok: true;
  added: number;
  skippedNoEmail: number;
  skippedDuplicate: number;
}

/**
 * Progress frames from `GET /api/campaigns/:id/events`.
 * Mirrors `ICampaignProgress` in `server/src/services/campaign.service.ts`.
 */
export interface CampaignProgress {
  campaignId: string;
  type: 'CONTACT' | 'STATS' | 'STATUS';
  contactId?: string;
  contactStatus?: ContactStatus;
  campaignStatus?: CampaignStatus;
  sentCount?: number;
  failedCount?: number;
  totalContacts?: number;
  message?: string;
}

/**
 * One frame of `GET /api/campaigns/contacts/:id/draft-stream`.
 *
 * `chunk` carries raw model output as it arrives; `done` carries the composed
 * draft — subject extracted, preamble stripped, signature appended — which is
 * what a save should store, not the accumulated chunks.
 */
export type DraftStreamFrame =
  | { type: 'chunk'; text: string }
  | { type: 'done'; subject: string; body: string }
  | { type: 'error'; message: string };

/**
 * `smtpPassword` is absent by design — the server never returns it, in any
 * form. `smtpConfigured` is what the UI branches on.
 */
export interface OutreachSettings {
  smtpUser: string | null;
  smtpFromName: string | null;
  emailSignature: string | null;
  resumeFileName: string | null;
  smtpConfigured: boolean;
}

export interface OutreachSettingsResponse {
  ok: true;
  settings: OutreachSettings;
}

export interface VerifyResponse {
  ok: true;
  verified: boolean;
  error?: string;
}
