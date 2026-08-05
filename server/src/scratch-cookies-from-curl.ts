// ─── Cookie Importer: "Copy as cURL" → linkedin-cookies.json ─────
// li_at is HttpOnly, so document.cookie can never read it. But the browser
// sends it on every request, so a copied request carries the full jar.
//
//   1. linkedin.com → DevTools → Network → filter "voyager"
//   2. Right-click any request → Copy → Copy as cURL
//   3. npm run cookies:import
//
// Reads the clipboard (macOS pbpaste) by default. Otherwise:
//   npm run cookies:import -- path/to/curl.txt
//   pbpaste | npm run cookies:import -- -

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const OUT_FILE = resolve(process.cwd(), 'linkedin-cookies.json');

const WANTED = [
  'li_at',
  'JSESSIONID',
  'bcookie',
  'bscookie',
  'lidc',
  'li_rm',
  'liap',
  'li_gc',
  'lang',
  'timezone',
];
const REQUIRED = ['li_at', 'JSESSIONID', 'bcookie'];

function readSource(): string {
  const arg = process.argv[2];

  if (arg === '-') return readFileSync(0, 'utf8');
  if (arg) {
    if (!existsSync(arg)) {
      console.error(`❌ No such file: ${arg}`);
      process.exit(1);
    }
    return readFileSync(arg, 'utf8');
  }

  try {
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (clip.trim()) {
      console.log('📋 Read from clipboard');
      return clip;
    }
  } catch {
    /* not macOS, or pbpaste unavailable */
  }

  console.error(
    '❌ Nothing to read. Copy the cURL first, or pass a file:\n' +
      '   npm run cookies:import -- curl.txt',
  );
  process.exit(1);
}

/**
 * Pull a header value out of a copied cURL command.
 * Chrome emits -H 'name: value' (bash) or -H "name: value" (Windows).
 */
function extractHeader(curl: string, name: string): string | null {
  const re = new RegExp(`-H\\s+(['"])\\s*${name}\\s*:\\s*([\\s\\S]*?)\\1`, 'i');
  const m = curl.match(re);
  if (m) return m[2].trim();

  // -b / --cookie carry the jar on some copy variants
  if (name === 'cookie') {
    const b = curl.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
    if (b) return b[2].trim();
  }
  return null;
}

function parseCookieHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (WANTED.includes(name) && value) out[name] = value;
  }
  return out;
}

function main() {
  const src = readSource();

  if (!/curl\s/i.test(src)) {
    console.error(
      '❌ That does not look like a cURL command.\n' +
        '   Network tab → right-click a request → Copy → Copy as cURL',
    );
    process.exit(1);
  }
  if (!/linkedin\.com/i.test(src)) {
    console.error('❌ That cURL is not for linkedin.com.');
    process.exit(1);
  }

  const cookieHeader = extractHeader(src, 'cookie');
  if (!cookieHeader) {
    console.error(
      '❌ No cookie header found.\n' +
        '   Pick a request to www.linkedin.com while logged in — static asset\n' +
        '   requests (licdn.com) carry no cookies.',
    );
    process.exit(1);
  }

  const cookies = parseCookieHeader(cookieHeader);
  const userAgent =
    extractHeader(src, 'user-agent') ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const missing = REQUIRED.filter((c) => !cookies[c]);
  if (missing.length) {
    console.error(`❌ Missing required cookie(s): ${missing.join(', ')}`);
    console.error(`   Found: ${Object.keys(cookies).join(', ') || '(none)'}`);
    console.error(
      '   Make sure you are logged in and copied a www.linkedin.com request.',
    );
    process.exit(1);
  }

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        cookies,
        userAgent,
        timezoneOffset: -(new Date().getTimezoneOffset() / 60),
        exportedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(`\n✅ Wrote ${OUT_FILE}`);
  console.log(`   Cookies:  ${Object.keys(cookies).join(', ')}`);
  console.log(`   UA:       ${userAgent.slice(0, 60)}...`);
  if (!cookies.li_rm) {
    console.log(
      '\n   ⚠️  No li_rm — that is the cookie LinkedIn uses to silently\n' +
        '      re-issue li_at, so the day-2 test is more likely to fail.\n' +
        '      Log out and back in with "Remember me" ticked to get one.',
    );
  }
  console.log('\n   Next: npm run probe:linkedin -- --quick\n');
}

main();
