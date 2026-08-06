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
