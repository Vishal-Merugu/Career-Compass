// ─── Server-Side Voyager Viability Probe ─────────────────────────
// Answers ONE question before we build anything: can this server hold a
// LinkedIn session across many calls over time, or does it get killed?
//
// Read-only endpoints only. No connection requests, no writes.
//
//   npm run probe:linkedin -- --quick      ~4 min,  6 calls
//   npm run probe:linkedin -- --sustained  ~35 min, 10 calls   (default)
//   npm run probe:linkedin -- --long       ~4 h,    14 calls
//
// Needs server/linkedin-cookies.json (gitignored). Run the snippet the
// script prints if it's missing.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COOKIE_FILE = resolve(process.cwd(), 'linkedin-cookies.json');
const REPORT_FILE = resolve(process.cwd(), 'probe-report.json');
const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

// Cookies LinkedIn's risk engine expects to see on a real session.
const CRITICAL_COOKIES = ['li_at', 'JSESSIONID', 'bcookie', 'lidc'];

// Per-provider budget for the egress lookup. Short on purpose: it runs before
// the probe and four dead providers must not add minutes to the start.
const EGRESS_TIMEOUT_MS = 6_000;

/**
 * An undici `Dispatcher`, kept structural so `undici` stays an optional
 * dependency — the probe runs without it whenever PROXY_URL is unset.
 */
type Dispatcher = object | undefined;

export interface CookieExport {
  cookies: Record<string, string>;
  userAgent: string;
  timezoneOffset?: number;
  exportedAt?: string;
}

interface CallResult {
  n: number;
  phase: string;
  at: string;
  label: string;
  status: number | null;
  ms: number;
  ok: boolean;
  rotated: string[];
  cleared: string[];
  fatal: string | null;
  note?: string;
}

/** Cookies whose removal by the server means the session is over. */
const AUTH_COOKIES = ['li_at', 'liap', 'li_a'];

// ─── Cookie jar ──────────────────────────────────────────────────
// The previous implementation hand-built a static cookie header and never
// read Set-Cookie back. LinkedIn rotates JSESSIONID and lidc constantly, so
// the csrf-token header went stale and every call 403'd. This jar fixes that.

export class CookieJar {
  private jar: Map<string, string>;
  public userAgent: string;
  public timezoneOffset: number;

  constructor(exported: CookieExport) {
    this.jar = new Map(Object.entries(exported.cookies));
    this.userAgent = exported.userAgent;
    this.timezoneOffset = exported.timezoneOffset ?? 5.5;
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** JSESSIONID doubles as the CSRF token, quotes stripped. */
  csrf(): string {
    return (this.jar.get('JSESSIONID') ?? '').replace(/"/g, '');
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * Absorb Set-Cookie from a response.
   *
   * LinkedIn kills a session by *expiring* cookies, not by omitting them:
   *   set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970...; Max-Age=0
   * Treating that as a value rotation writes the literal string "delete me"
   * into the jar and corrupts the export, so expiry is detected by attribute
   * (Max-Age=0 / past Expires), never by sniffing the value.
   */
  absorb(setCookies: string[]): { rotated: string[]; cleared: string[] } {
    const rotated: string[] = [];
    const cleared: string[] = [];

    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();

      let expired = false;
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=').map((s) => s.trim());
        if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
        if (/^expires$/i.test(k)) {
          const t = Date.parse(v);
          if (!Number.isNaN(t) && t <= Date.now()) expired = true;
        }
      }

      if (expired) {
        if (this.jar.delete(name)) cleared.push(name);
        continue;
      }
      if (!value || value === '""') continue;
      if (this.jar.get(name) !== value) {
        if (this.jar.has(name)) rotated.push(name);
        this.jar.set(name, value);
      }
    }
    return { rotated, cleared };
  }

  persist(source: CookieExport): void {
    const out: CookieExport = {
      ...source,
      cookies: Object.fromEntries(this.jar),
      exportedAt: source.exportedAt,
    };
    writeFileSync(COOKIE_FILE, JSON.stringify(out, null, 2));
  }

  missingCritical(): string[] {
    return CRITICAL_COOKIES.filter((c) => !this.jar.get(c));
  }
}

// ─── Probe endpoints (all read-only) ─────────────────────────────

const ENDPOINTS: { label: string; path: string; accept?: string }[] = [
  {
    label: 'me',
    path: '/me',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
  },
  {
    label: 'jobSearch',
    path:
      '/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220' +
      '&count=5&q=jobSearch&start=0&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:engineer,' +
      'locationUnion:(geoId:102713980),spellCorrectionEnabled:true)',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
  },
  {
    label: 'company',
    path:
      '/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12' +
      '&q=universalName&universalName=microsoft',
  },
  {
    label: 'feedIdentity',
    path: '/identity/dash/profiles?q=memberIdentity&memberIdentity=williamhgates&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-3',
  },
];

// ─── Phases ──────────────────────────────────────────────────────
// Gap sizes matter more than call count. The failure mode we're hunting
// (silent session kill) usually shows up on the *next* call after a gap,
// not inside a burst.

type Phase = {
  name: string;
  calls: number;
  minGapMs: number;
  maxGapMs: number;
};

const PROFILES: Record<string, Phase[]> = {
  quick: [{ name: 'burst', calls: 6, minGapMs: 25_000, maxGapMs: 50_000 }],
  sustained: [
    { name: 'burst', calls: 5, minGapMs: 25_000, maxGapMs: 50_000 },
    { name: 'spaced', calls: 5, minGapMs: 240_000, maxGapMs: 420_000 },
  ],
  long: [
    { name: 'burst', calls: 5, minGapMs: 25_000, maxGapMs: 50_000 },
    { name: 'spaced', calls: 5, minGapMs: 240_000, maxGapMs: 420_000 },
    { name: 'cold', calls: 4, minGapMs: 2_400_000, maxGapMs: 3_000_000 },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ─── Egress attribution ──────────────────────────────────────────
// A run whose egress is unknown proves nothing: "the session survived" is only
// meaningful attached to the network it survived *from*.

/** All-string so it drops straight into the JSON report. */
export type EgressInfo = Record<string, string>;

interface EgressProvider {
  name: string;
  url: string;
  map: (json: unknown) => Partial<EgressInfo>;
}

/**
 * Read a (possibly nested) string field out of an unknown JSON body.
 * Providers disagree on both field names and nesting, and every one of them
 * has reshaped its response at some point — so nothing here may assume a shape.
 */
export function pick(json: unknown, path: string): string | undefined {
  let cur: unknown = json;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === 'string') return cur.trim() || undefined;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return undefined;
}

/**
 * Tried in order until one answers. ipinfo.io is first because it is the
 * richest and every earlier report used it — but it is hosted on GCP, which
 * the VM's container network cannot reach, so it timed out on the whole --long
 * run and that report has `"egress": {}`. The rest are on different networks
 * deliberately: the point of a fallback chain is not to share a failure mode.
 */
const EGRESS_PROVIDERS: readonly EgressProvider[] = [
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    map: (j) => ({
      ip: pick(j, 'ip'),
      city: pick(j, 'city'),
      country: pick(j, 'country'),
      org: pick(j, 'org'),
    }),
  },
  {
    name: 'ipapi.is',
    url: 'https://api.ipapi.is/',
    map: (j) => ({
      ip: pick(j, 'ip'),
      city: pick(j, 'location.city'),
      country: pick(j, 'location.country_code') ?? pick(j, 'cc'),
      org: pick(j, 'asn.org') ?? pick(j, 'asn_org') ?? pick(j, 'company_name'),
      // The one field that speaks directly to risk: LinkedIn scores hosting
      // ASNs differently from consumer/university ones.
      datacenter: pick(j, 'is_datacenter'),
    }),
  },
  {
    name: 'ifconfig.co',
    url: 'https://ifconfig.co/json',
    map: (j) => ({
      ip: pick(j, 'ip'),
      city: pick(j, 'city'),
      country: pick(j, 'country_iso'),
      org: pick(j, 'asn_org'),
    }),
  },
  {
    name: 'geojs.io',
    url: 'https://get.geojs.io/v1/ip/geo.json',
    map: (j) => ({
      ip: pick(j, 'ip'),
      city: pick(j, 'city'),
      country: pick(j, 'country_code'),
      org: pick(j, 'organization_name') ?? pick(j, 'organization'),
    }),
  },
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * Normalise one provider's payload. Returns null when the answer is unusable —
 * a body without a plausible IP is a captive portal or an error page, and
 * recording `ip: "?"` from it would be worse than recording nothing.
 */
export function normaliseEgress(
  source: string,
  raw: Partial<EgressInfo>,
): EgressInfo | null {
  const ip = raw.ip;
  if (!ip || !(IPV4.test(ip) || IPV6.test(ip))) return null;
  const info: EgressInfo = { ip, source };
  for (const key of ['city', 'country', 'org', 'datacenter'] as const) {
    const value = raw[key];
    if (value) info[key] = value;
  }
  return info;
}

/**
 * Report the egress IP/ASN actually used for the run.
 *
 * Being inside a network is not the same as sharing its egress: a VM can NAT
 * out through a different gateway than the VPN client you browse from. Run the
 * probe in both places and compare these lines — if the org/ASN differs, the
 * "LinkedIn already knows this network" assumption doesn't hold.
 *
 * Goes through the proxy dispatcher when there is one, so the line reports the
 * path the Voyager calls actually take rather than the host's own route.
 */
async function reportEgress(dispatcher: Dispatcher): Promise<EgressInfo> {
  const failures: string[] = [];

  for (const provider of EGRESS_PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (!res.ok) {
        failures.push(`${provider.name}: HTTP ${res.status}`);
        continue;
      }
      const info = normaliseEgress(
        provider.name,
        provider.map(await res.json()),
      );
      if (!info) {
        failures.push(`${provider.name}: no IP in response`);
        continue;
      }
      console.log(
        `   Egress:     ${info.ip} — ${info.city ?? '?'}, ${info.country ?? '?'}` +
          ` — ${info.org ?? '?'}  [${provider.name}]`,
      );
      if (info.datacenter === 'true') {
        console.log(
          '               ⚠️  datacenter ASN — LinkedIn risk-scores these\n' +
            '                  harder than consumer/university networks.',
        );
      }
      if (failures.length)
        console.log(`               (after ${failures.join(', ')})`);
      return info;
    } catch (err) {
      failures.push(`${provider.name}: ${errText(err)}`);
    }
  }

  // Previously this was a bare `catch {}` printing "(lookup failed)", which is
  // why the --long run's failure went undiagnosed for hours. Say what broke.
  console.log('   Egress:     ⚠️  UNKNOWN — all lookups failed');
  for (const f of failures) console.log(`               ${f}`);
  console.log(
    '               The run continues, but its result cannot be\n' +
      '               attributed to a network. Fix this before drawing\n' +
      '               any conclusion about whether the egress is trusted.',
  );
  return { error: failures.join('; ') };
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    // fetch wraps the real reason (ETIMEDOUT, ENOTFOUND, cert errors) in `cause`.
    const cause = err.cause;
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    return `${err.name === 'TimeoutError' ? 'timed out' : err.message}${detail}`;
  }
  return String(err);
}

/** Optional proxy — only needed if the egress network is not already trusted. */
async function buildDispatcher(): Promise<Dispatcher> {
  const url = process.env.PROXY_URL;
  if (!url) return undefined;
  try {
    // Runtime-resolved so `undici` stays an optional dependency.
    const specifier = 'undici';
    const { ProxyAgent } = await import(specifier);
    console.log(
      `🌐 Routing through proxy: ${url.replace(/:[^:@]+@/, ':***@')}`,
    );
    return new ProxyAgent(url);
  } catch {
    console.error(
      '⚠️  PROXY_URL set but `undici` is not installed. Run: npm i -D undici',
    );
    process.exit(1);
  }
}

export function classifyFatal(
  status: number,
  location: string,
  body: string,
  cleared: string[],
): string | null {
  // Strongest signal, and the one the self-test surfaced: LinkedIn expires the
  // auth cookies outright. Check before status, since it rides on a 302.
  const killedAuth = cleared.filter((c) => AUTH_COOKIES.includes(c));
  if (killedAuth.length)
    return `Server expired auth cookie(s): ${killedAuth.join(', ')} — session rejected`;

  if (status === 401) return 'HTTP 401 — session rejected';
  if (/\/uas\/login|\/checkpoint\/|session_redirect|authwall/.test(location))
    return `Redirected to login/checkpoint (${location.slice(0, 80)})`;
  // The Voyager API never legitimately redirects. A bare 3xx — including the
  // self-redirect to the same URL that a dead session produces — is fatal.
  if (status >= 300 && status < 400)
    return `HTTP ${status} — Voyager redirected (${location.slice(0, 60) || 'no location'}); API never does this on a live session`;
  if (status === 403) {
    if (/csrf/i.test(body)) return 'HTTP 403 — CSRF token rejected';
    return 'HTTP 403 — blocked (rate/bot detection or dead session)';
  }
  if (status === 999) return 'HTTP 999 — LinkedIn bot wall';
  return null;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const profileName =
    (['quick', 'sustained', 'long'] as const).find((p) =>
      args.includes(`--${p}`),
    ) ?? 'sustained';
  const phases = PROFILES[profileName];

  // Egress attribution is a precondition for the whole probe, so it must be
  // checkable on its own — finding out it is broken at the *end* of a 4h run
  // is how the first --long run came back unattributable. Needs no cookies and
  // touches nothing LinkedIn owns.
  if (args.includes('--egress-only')) {
    await reportEgress(await buildDispatcher());
    return;
  }

  if (!existsSync(COOKIE_FILE)) {
    printCookieInstructions();
    process.exit(1);
  }

  const exported: CookieExport = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
  if (!exported.cookies || !exported.userAgent) {
    console.error('❌ linkedin-cookies.json missing `cookies` or `userAgent`.');
    printCookieInstructions();
    process.exit(1);
  }

  const jar = new CookieJar(exported);
  const missing = jar.missingCritical();

  const totalCalls = phases.reduce((n, p) => n + p.calls, 0);
  const estMs = phases.reduce(
    (t, p) => t + p.calls * ((p.minGapMs + p.maxGapMs) / 2),
    0,
  );

  console.log('━'.repeat(64));
  console.log(`🔬 Voyager server-side viability probe — "${profileName}"`);
  console.log('━'.repeat(64));
  console.log(`   Calls:      ${totalCalls} across ${phases.length} phase(s)`);
  console.log(`   Est. time:  ~${fmtDuration(estMs)}`);
  console.log(`   Cookies:    ${Object.keys(exported.cookies).length} loaded`);
  console.log(`   UA:         ${jar.userAgent.slice(0, 58)}...`);
  if (missing.length) {
    console.log(`   ⚠️  MISSING: ${missing.join(', ')} — expect early failure`);
  }
  if (exported.exportedAt) {
    const ageH = (Date.now() - Date.parse(exported.exportedAt)) / 3.6e6;
    console.log(`   Cookie age: ${ageH.toFixed(1)}h`);
  }
  console.log(
    '\n   Read-only calls only. Keep LinkedIn open in your browser and\n' +
      '   re-check it after the run — a UI logout is the real failure signal.\n',
  );

  const dispatcher = await buildDispatcher();
  const egress = await reportEgress(dispatcher);
  const results: CallResult[] = [];
  let n = 0;
  let fatal: CallResult | null = null;

  outer: for (const phase of phases) {
    console.log(
      `\n── Phase "${phase.name}" — ${phase.calls} calls, ` +
        `${fmtDuration(phase.minGapMs)}–${fmtDuration(phase.maxGapMs)} apart ──`,
    );

    for (let i = 0; i < phase.calls; i++) {
      const gap = jitter(phase.minGapMs, phase.maxGapMs);
      process.stdout.write(`   ⏳ waiting ${fmtDuration(gap)}...\r`);
      await sleep(gap);

      n++;
      const ep = ENDPOINTS[n % ENDPOINTS.length];
      const result = await probeOnce(n, phase.name, ep, jar, dispatcher);
      results.push(result);
      // Never write back a jar the server just gutted — that would overwrite
      // the export with a dead session and force a needless re-extraction.
      if (!result.fatal) jar.persist(exported);

      const icon = result.fatal ? '💀' : result.ok ? '✅' : '⚠️ ';
      const rot = [
        ...result.rotated.map((c) => `↻${c}`),
        ...result.cleared.map((c) => `✗${c}`),
      ].join(',');
      console.log(
        `   ${icon} #${String(n).padStart(2)} ${result.label.padEnd(13)} ` +
          `${result.status ?? 'ERR'}  ${String(result.ms).padStart(5)}ms` +
          `${rot ? `  ${rot}` : ''}${result.note ? `  ${result.note}` : ''}`,
      );

      if (result.fatal) {
        console.log(`      └─ ${result.fatal}`);
        fatal = result;
        break outer;
      }
    }
  }

  report(results, fatal, profileName, jar, egress);
}

async function probeOnce(
  n: number,
  phase: string,
  ep: { label: string; path: string; accept?: string },
  jar: CookieJar,
  dispatcher: Dispatcher,
): Promise<CallResult> {
  const started = Date.now();
  const base: CallResult = {
    n,
    phase,
    at: new Date().toISOString(),
    label: ep.label,
    status: null,
    ms: 0,
    ok: false,
    rotated: [],
    cleared: [],
    fatal: null,
  };

  try {
    const res = await fetch(VOYAGER_BASE + ep.path, {
      method: 'GET',
      // manual: a 302 to /uas/login is the clearest "session is dead" signal,
      // and following it would hide that behind a 200 HTML page.
      redirect: 'manual',
      headers: {
        cookie: jar.header(),
        'csrf-token': jar.csrf(), // read live each call — it rotates
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        'x-li-track': JSON.stringify({
          clientVersion: '1.13.42510',
          mpVersion: '1.13.42510',
          osName: 'web',
          timezoneOffset: jar.timezoneOffset,
          deviceFormFactor: 'DESKTOP',
          mpName: 'voyager-web',
        }),
        accept: ep.accept ?? 'application/vnd.linkedin.normalized+json+2.1',
        'user-agent': jar.userAgent,
        referer: 'https://www.linkedin.com/feed/',
        'accept-language': 'en-US,en;q=0.9',
      },
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    base.ms = Date.now() - started;
    base.status = res.status;
    const { rotated, cleared } = jar.absorb(res.headers.getSetCookie());
    base.rotated = rotated;
    base.cleared = cleared;

    const location = res.headers.get('location') ?? '';
    const body = await res.text().catch(() => '');

    base.fatal = classifyFatal(res.status, location, body, cleared);
    base.ok = res.status >= 200 && res.status < 300 && !base.fatal;

    if (base.ok) {
      // A 200 that's actually an HTML login page is still a dead session.
      if (/^\s*</.test(body)) {
        base.ok = false;
        base.fatal = 'HTTP 200 but HTML body — auth wall behind a 200';
      } else {
        base.note = `${(body.length / 1024).toFixed(1)}kb`;
      }
    } else if (!base.fatal && res.status === 429) {
      base.note = 'rate limited (not fatal — session alive)';
    }
  } catch (err: any) {
    base.ms = Date.now() - started;
    base.note = `network: ${err?.message?.slice(0, 60)}`;
  }

  return base;
}

function report(
  results: CallResult[],
  fatal: CallResult | null,
  profileName: string,
  jar: CookieJar,
  egress: EgressInfo,
) {
  const ok = results.filter((r) => r.ok).length;
  const rotations = results.flatMap((r) => r.rotated);
  const uniqRotated = [...new Set(rotations)];
  const uniqCleared = [...new Set(results.flatMap((r) => r.cleared))];

  console.log('\n' + '━'.repeat(64));
  console.log('📋 RESULT');
  console.log('━'.repeat(64));
  console.log(`   Succeeded:        ${ok}/${results.length}`);
  // Repeated here, not just at the top: by the time a --long run finishes the
  // header has scrolled away, and the verdict is meaningless without it.
  console.log(
    `   Egress:           ${
      egress.ip
        ? `${egress.ip} — ${egress.org ?? '?'}` +
          (egress.datacenter === 'true' ? ' (datacenter ASN)' : '')
        : '⚠️  unknown — verdict is not attributable to a network'
    }`,
  );
  console.log(
    `   Cookies rotated:  ${uniqRotated.length ? uniqRotated.join(', ') : 'none'}` +
      ` (${rotations.length} times)`,
  );
  if (uniqCleared.length)
    console.log(`   Cookies expired:  ${uniqCleared.join(', ')} (by server)`);

  if (fatal) {
    console.log(`   Died at call:     #${fatal.n} (phase "${fatal.phase}")`);
    console.log(`   Cause:            ${fatal.fatal}`);
    console.log('\n   ❌ VERDICT: server-side Voyager is NOT viable as-is.');
    if (fatal.n <= 2) {
      console.log(
        '      Failed almost immediately → cookie set or headers are wrong,\n' +
          '      not a risk-engine kill. Re-export cookies and retry before\n' +
          '      concluding anything about proxies.',
      );
    } else if (fatal.cleared.length) {
      console.log(
        '      Survived a while, then the server expired the auth cookies →\n' +
          '      risk engine. Compare the Egress line above with what your\n' +
          '      browser shows on the same VPN; if the org/ASN differs, the\n' +
          '      network is not as trusted as it looks.',
      );
    } else {
      console.log(
        '      Died without the auth cookies being expired → more likely a\n' +
          "      transport/fingerprint block than a session kill. Node's TLS\n" +
          "      signature is not Chrome's, and no IP fixes that — a headless\n" +
          '      real browser is the next thing to try.',
      );
    }
  } else if (ok === results.length) {
    console.log('\n   ✅ VERDICT: viable for this profile.');
    if (profileName !== 'long') {
      console.log(
        '      Now run --long before trusting it. Short runs pass even when\n' +
          '      the session dies hours later, which is the failure you hit.',
      );
    } else {
      console.log(
        '      Survived the cold-gap phase. Check the LinkedIn UI in your\n' +
          '      browser now — if you were logged out, it still failed.',
      );
    }
  } else {
    console.log(
      '\n   ⚠️  VERDICT: mixed — no hard kill, but not clean either.',
    );
    console.log('      Inspect probe-report.json for the non-200s.');
  }

  if (!uniqRotated.includes('JSESSIONID') && results.length > 3) {
    console.log(
      '\n   Note: JSESSIONID never rotated. Either the run was too short or\n' +
        '   responses carried no Set-Cookie — worth confirming before you\n' +
        '   rely on the jar for a long-lived worker.',
    );
  }

  writeFileSync(
    REPORT_FILE,
    JSON.stringify(
      {
        profile: profileName,
        ranAt: new Date().toISOString(),
        proxy: process.env.PROXY_URL ? 'yes' : 'no',
        egress,
        succeeded: ok,
        total: results.length,
        fatal,
        rotated: uniqRotated,
        clearedByServer: uniqCleared,
        finalCookiesPresent: CRITICAL_COOKIES.filter((c) => !!jar.get(c)),
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n   📄 Full log: ${REPORT_FILE}\n`);
}

function printCookieInstructions() {
  console.log(`
❌ Missing ${COOKIE_FILE}

li_at is httpOnly, so DevTools console can't read it. Use the extension —
it already has the "cookies" permission.

  1. chrome://extensions → CareerCompass → "service worker"
  2. Paste this into that console:

─────────────────────────────────────────────────────────────────
(async () => {
  // No leading dot: matches linkedin.com AND .www.linkedin.com (where li_at lives)
  const all = await chrome.cookies.getAll({ domain: 'linkedin.com' });
  const wanted = ['li_at','JSESSIONID','bcookie','bscookie','lidc','li_rm',
                  'liap','li_gc','lang','timezone'];
  const cookies = {};
  for (const name of wanted) {
    // Prefer the most specific host cookie if the name appears more than once
    const hits = all.filter(c => c.name === name);
    if (hits.length) cookies[name] = hits.sort(
      (a, b) => b.domain.length - a.domain.length)[0].value;
  }
  const out = JSON.stringify({
    cookies,
    userAgent: navigator.userAgent,
    timezoneOffset: -(new Date().getTimezoneOffset() / 60),
    exportedAt: new Date().toISOString(),
  }, null, 2);
  const missing = ['li_at','JSESSIONID','bcookie'].filter(n => !cookies[n]);
  console.log(out);
  if (missing.length) console.warn('⚠️ MISSING:', missing.join(', '),
    '— open linkedin.com, make sure you are logged in, then re-run');
  else console.log('✅ Got', Object.keys(cookies).length, 'cookies. Copy the JSON above.');
  try { copy(out); console.log('📋 Also copied to clipboard'); } catch {}
})();
─────────────────────────────────────────────────────────────────

  3. Paste the clipboard into server/linkedin-cookies.json
     (already gitignored)
  4. Re-run this probe.
`);
}

// Only run when invoked directly (`npm run probe:linkedin`). CookieJar and
// classifyFatal are imported by tests, and importing this file must not fire off
// a four-hour probe against LinkedIn.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n💥 Probe crashed:', err);
    process.exit(1);
  });
}
