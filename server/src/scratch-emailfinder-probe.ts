// One-off probe for the server-side email finder.
//
//   npx tsx src/scratch-emailfinder-probe.ts                  # full stack
//   npx tsx src/scratch-emailfinder-probe.ts --smtp-only      # port 25 check
//
// The port-25 check is the one that decides whether layer 2 can verify
// anything on a given host. Run it on the VM before trusting SMTP verdicts.

import { verifyEmailViaSmtp } from './services/emailFinder/smtpVerify.js';
import { resolveCompanyDomain } from './services/emailFinder/domain.js';

async function probeSmtp(): Promise<void> {
  console.log('\n── SMTP egress ──────────────────────────────');
  const result = await verifyEmailViaSmtp('postmaster@gmail.com');
  console.log(`  verdict: ${result.verdict}`);
  console.log(`  detail:  ${result.detail ?? '—'}`);
  if (result.verdict === 'blocked') {
    console.log('  ⚠️  Outbound port 25 is blocked on this host.');
    console.log('     Layer 2 will emit guesses, never verified addresses.');
  }
}

async function probeDomains(): Promise<void> {
  console.log('\n── Domain resolution ────────────────────────');
  for (const name of ['Stripe', 'Siemens', 'Palantir Technologies']) {
    const domain = await resolveCompanyDomain(name);
    console.log(`  ${name.padEnd(24)} → ${domain ?? 'unresolved'}`);
  }
}

async function main(): Promise<void> {
  const smtpOnly = process.argv.includes('--smtp-only');

  await probeSmtp();
  if (smtpOnly) return;

  await probeDomains();
}

// Guarded so importing this file in a test does not execute the probe.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
