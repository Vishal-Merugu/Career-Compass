#!/usr/bin/env node
// ─── Mailmeteor + Pattern Generator Test ─────────────────────────
// Tests:
//   1. Mailmeteor.com — try multiple approaches to bypass Cloudflare
//   2. Email pattern generator + DNS MX validation

import dns from 'dns/promises';

// ═══════════════════════════════════════════════════════════════════
// TEST 1: Mailmeteor.com — Multiple bypass attempts
// ═══════════════════════════════════════════════════════════════════

async function testMailmeteor() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 1: Mailmeteor.com — Cloudflare Bypass Attempts');
  console.log('═'.repeat(60));

  const browserHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Sec-Ch-Ua':
      '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  // Attempt 1: Direct GET to email finder page
  console.log('\n--- Attempt 1: Direct GET /email-finder ---');
  try {
    const res = await fetch('https://mailmeteor.com/email-finder', {
      headers: browserHeaders,
      redirect: 'follow',
    });
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Size: ${body.length} bytes`);
    console.log(
      `  Has Turnstile: ${body.includes('turnstile') || body.includes('challenges.cloudflare')}`,
    );
    console.log(
      `  Has Cloudflare challenge: ${body.includes('challenge-platform') || body.includes('cf-challenge')}`,
    );
    console.log(
      `  Has real content: ${body.includes('Find anyone') || body.includes('email finder') || body.includes('Email Finder')}`,
    );
    console.log(
      `  Title: ${body.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || 'N/A'}`,
    );
    // Show a snippet
    const snippet = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    console.log(`  Text snippet: ${snippet}`);
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  // Attempt 2: Direct GET to main page
  console.log('\n--- Attempt 2: Direct GET / (main page) ---');
  try {
    const res = await fetch('https://mailmeteor.com/', {
      headers: browserHeaders,
      redirect: 'follow',
    });
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Size: ${body.length} bytes`);
    console.log(
      `  Has Turnstile: ${body.includes('turnstile') || body.includes('challenges.cloudflare')}`,
    );
    console.log(
      `  Has challenge: ${body.includes('challenge-platform') || body.includes('Checking your browser')}`,
    );
    console.log(
      `  Title: ${body.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || 'N/A'}`,
    );
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  // Attempt 3: Try common API paths
  console.log('\n--- Attempt 3: Probe API endpoints ---');
  const apiPaths = [
    '/api/email-finder',
    '/api/v1/email-finder',
    '/api/find-email',
    '/api/search',
    '/api/email/find',
    '/_api/email-finder',
    '/email-finder/api',
  ];

  for (const path of apiPaths) {
    try {
      const res = await fetch(`https://mailmeteor.com${path}`, {
        method: 'POST',
        headers: {
          ...browserHeaders,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          Origin: 'https://mailmeteor.com',
          Referer: 'https://mailmeteor.com/email-finder',
        },
        body: JSON.stringify({
          firstName: 'Sundar',
          lastName: 'Pichai',
          domain: 'google.com',
        }),
      });
      const contentType = res.headers.get('content-type') || '';
      const body = await res.text();
      const isChallenge =
        body.includes('challenge') || body.includes('turnstile');
      console.log(
        `  POST ${path} → ${res.status} | ${contentType.split(';')[0]} | ${body.length}b | challenge:${isChallenge}`,
      );
      if (res.status === 200 && !isChallenge && body.length < 2000) {
        console.log(`    Response: ${body.slice(0, 300)}`);
      }
    } catch (err) {
      console.log(`  POST ${path} → ❌ ${err.message}`);
    }
  }

  // Attempt 4: Try GET with JSON accept (some APIs respond to this)
  console.log('\n--- Attempt 4: GET with JSON accept ---');
  try {
    const res = await fetch(
      'https://mailmeteor.com/email-finder?firstName=Sundar&lastName=Pichai&domain=google.com',
      {
        headers: {
          ...browserHeaders,
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    );
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Size: ${body.length} bytes`);
    console.log(`  Has challenge: ${body.includes('challenge-platform')}`);
    if (body.length < 1000) console.log(`  Body: ${body.slice(0, 500)}`);
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  // Attempt 5: Check robots.txt and sitemap for clues
  console.log('\n--- Attempt 5: robots.txt / sitemap ---');
  try {
    const res = await fetch('https://mailmeteor.com/robots.txt', {
      headers: browserHeaders,
    });
    const body = await res.text();
    console.log(`  robots.txt status: ${res.status}`);
    if (!body.includes('challenge')) {
      console.log(`  Content:\n${body.slice(0, 800)}`);
    } else {
      console.log(`  ⚠️  robots.txt is behind Cloudflare challenge too`);
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// TEST 2: Email Pattern Generator + DNS MX Validation
// ═══════════════════════════════════════════════════════════════════

function generateEmailPatterns(firstName, lastName, domain) {
  const f = firstName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const l = lastName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const fi = f[0];
  const li = l[0];

  return [
    { email: `${f}.${l}@${domain}`, format: 'first.last', weight: 50 },
    { email: `${f}${l}@${domain}`, format: 'firstlast', weight: 15 },
    { email: `${fi}${l}@${domain}`, format: 'flast', weight: 12 },
    { email: `${f}${li}@${domain}`, format: 'firstl', weight: 5 },
    { email: `${fi}.${l}@${domain}`, format: 'f.last', weight: 8 },
    { email: `${f}_${l}@${domain}`, format: 'first_last', weight: 3 },
    { email: `${f}-${l}@${domain}`, format: 'first-last', weight: 3 },
    { email: `${l}.${f}@${domain}`, format: 'last.first', weight: 2 },
    { email: `${l}${f}@${domain}`, format: 'lastfirst', weight: 1 },
    { email: `${f}@${domain}`, format: 'first', weight: 1 },
  ];
}

async function checkMXRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return {
      valid: records.length > 0,
      records: records.sort((a, b) => a.priority - b.priority),
    };
  } catch (err) {
    return { valid: false, error: err.code || err.message };
  }
}

// Try SMTP RCPT TO verification (checks if mailbox actually exists)
async function verifyEmailSMTP(email, mxHost) {
  const net = await import('net');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ verified: false, reason: 'timeout' });
    }, 10000);

    const socket = net.default.createConnection(25, mxHost);
    let step = 0;
    let response = '';

    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      response += data;

      if (step === 0 && data.includes('220')) {
        // Server greeting received, send EHLO
        socket.write('EHLO mail.test.com\r\n');
        step = 1;
      } else if (step === 1 && data.includes('250')) {
        // EHLO accepted, send MAIL FROM
        socket.write('MAIL FROM:<test@test.com>\r\n');
        step = 2;
      } else if (step === 2 && data.includes('250')) {
        // MAIL FROM accepted, send RCPT TO (this is the actual check)
        socket.write(`RCPT TO:<${email}>\r\n`);
        step = 3;
      } else if (step === 3) {
        clearTimeout(timeout);
        socket.write('QUIT\r\n');
        socket.end();

        if (data.includes('250')) {
          resolve({ verified: true, reason: 'accepted' });
        } else if (
          data.includes('550') ||
          data.includes('551') ||
          data.includes('553')
        ) {
          resolve({
            verified: false,
            reason: 'rejected - mailbox does not exist',
          });
        } else if (data.includes('452') || data.includes('421')) {
          resolve({ verified: false, reason: 'rate-limited or greylisted' });
        } else {
          resolve({
            verified: false,
            reason: `unknown response: ${data.trim().slice(0, 100)}`,
          });
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ verified: false, reason: `connection error: ${err.message}` });
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function testPatternGenerator() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 2: Email Pattern Generator + DNS/MX Validation');
  console.log('═'.repeat(60));

  // Test MX validation for various company domains
  const testDomains = [
    'google.com',
    'siemens.com',
    'sap.com',
    'bmw.com',
    'asana.com',
    'adidas.com',
    'bosch.com',
    'nonexistent-fake-company-12345.com',
  ];

  console.log('\n--- Step 1: MX Record Validation ---');
  const domainMx = {};
  for (const domain of testDomains) {
    const mx = await checkMXRecords(domain);
    domainMx[domain] = mx;
    if (mx.valid) {
      console.log(
        `  ✅ ${domain.padEnd(35)} → ${mx.records.length} MX records | primary: ${mx.records[0].exchange}`,
      );
    } else {
      console.log(`  ❌ ${domain.padEnd(35)} → No MX records (${mx.error})`);
    }
  }

  // Generate patterns
  console.log('\n--- Step 2: Pattern Generation ---');
  const person = {
    firstName: 'Sundar',
    lastName: 'Pichai',
    domain: 'google.com',
  };
  const patterns = generateEmailPatterns(
    person.firstName,
    person.lastName,
    person.domain,
  );
  console.log(
    `\n  Patterns for ${person.firstName} ${person.lastName} @ ${person.domain}:`,
  );
  patterns.forEach((p) => {
    console.log(
      `    ${p.format.padEnd(14)} → ${p.email.padEnd(35)} (weight: ${p.weight}%)`,
    );
  });

  // Try SMTP verification on the top pattern
  console.log(
    '\n--- Step 3: SMTP Verification (checking if mailbox exists) ---',
  );
  console.log(
    '  ⚠️  Note: Many mail servers block SMTP probes or use catch-all configs\n',
  );

  const smtpTests = [
    { email: 'sundar.pichai@google.com', domain: 'google.com' },
    { email: 'definitely.fake.person.12345@google.com', domain: 'google.com' },
    { email: 'info@siemens.com', domain: 'siemens.com' },
  ];

  for (const test of smtpTests) {
    const mx = domainMx[test.domain];
    if (!mx?.valid) {
      console.log(`  ⏭️  ${test.email} — skipped (no MX records)`);
      continue;
    }

    console.log(`  Testing: ${test.email} via ${mx.records[0].exchange}...`);
    const result = await verifyEmailSMTP(test.email, mx.records[0].exchange);
    console.log(`    ${result.verified ? '✅' : '❌'} ${result.reason}`);
  }

  // Show the complete flow for a realistic scenario
  console.log('\n--- Step 4: Full Flow Demo ---');
  const testPeople = [
    { firstName: 'Vishal', lastName: 'Sharma', domain: 'siemens.com' },
    { firstName: 'Max', lastName: 'Mueller', domain: 'bmw.com' },
    { firstName: 'Sarah', lastName: 'Johnson', domain: 'sap.com' },
  ];

  for (const p of testPeople) {
    console.log(`\n  📧 ${p.firstName} ${p.lastName} @ ${p.domain}`);
    const mx = await checkMXRecords(p.domain);
    if (!mx.valid) {
      console.log(`    ❌ Domain has no MX records — cannot receive email`);
      continue;
    }
    console.log(`    ✅ Domain valid (MX: ${mx.records[0].exchange})`);

    const patterns = generateEmailPatterns(p.firstName, p.lastName, p.domain);
    console.log(`    Top 3 guesses (by likelihood):`);
    patterns.slice(0, 3).forEach((pat, i) => {
      console.log(
        `      ${i + 1}. ${pat.email} (${pat.format}, ${pat.weight}% likely)`,
      );
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('🔍 Email Finder Feasibility Test');
  console.log(`Date: ${new Date().toISOString()}\n`);

  await testMailmeteor();
  await testPatternGenerator();

  console.log('\n' + '═'.repeat(60));
  console.log('ALL TESTS COMPLETE');
  console.log('═'.repeat(60));
}

main().catch(console.error);
