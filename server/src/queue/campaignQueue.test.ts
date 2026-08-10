import { describe, it, expect } from 'vitest';
import { campaignJobId } from './campaignQueue.js';

describe('campaignJobId', () => {
  const campaign = '069bfd94-69f9-41ea-9200-970f0f18bac7';
  const contact = 'c0ffee00-1111-2222-3333-444455556666';

  it('never contains a colon', () => {
    // BullMQ namespaces its Redis keys with ':' and throws
    // "Custom Id cannot contain :" from addBulk — after the credential check
    // has already passed, so the campaign 500s with nothing queued.
    expect(campaignJobId(campaign, contact)).not.toContain(':');
  });

  it('keeps both ids recoverable', () => {
    expect(campaignJobId(campaign, contact)).toBe(`${campaign}__${contact}`);
  });

  it('is unique per contact, so Start twice cannot double-send', () => {
    const other = 'deadbeef-1111-2222-3333-444455556666';
    expect(campaignJobId(campaign, contact)).not.toBe(
      campaignJobId(campaign, other),
    );
  });
});
