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

export interface CampaignDetailResponse {
  ok: true;
  campaign: Campaign;
  contacts: CampaignContact[];
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
