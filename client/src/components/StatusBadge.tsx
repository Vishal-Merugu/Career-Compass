import { Badge } from '@mantine/core';
import type { CampaignStatus, ContactStatus } from '../api/types';

/**
 * Status is one of the few things in this UI that earns a hue — the rest of
 * the palette is deliberately monochrome, so a colour here means "state", not
 * "category". Both maps live in one file because the campaign list and the
 * campaign detail screen were drifting: the list used a lookup table, the
 * detail page used a three-deep nested ternary that quietly rendered STOPPED
 * as grey while the list rendered it orange.
 */
const CAMPAIGN_COLOR: Record<CampaignStatus, string> = {
  PENDING: 'gray',
  SENDING: 'blue',
  COMPLETE: 'teal',
  STOPPED: 'orange',
  FAILED: 'red',
};

const CONTACT_COLOR: Record<ContactStatus, string> = {
  PENDING: 'gray',
  GENERATING: 'violet',
  SENDING: 'blue',
  SUCCESS: 'teal',
  FAILED: 'red',
  SKIPPED: 'gray',
};

export function CampaignStatusBadge({
  status,
  size = 'sm',
}: {
  status: CampaignStatus;
  size?: string;
}) {
  return (
    <Badge size={size} variant="light" color={CAMPAIGN_COLOR[status]}>
      {status.toLowerCase()}
    </Badge>
  );
}

export function ContactStatusBadge({ status }: { status: ContactStatus }) {
  return (
    <Badge size="sm" variant="light" color={CONTACT_COLOR[status]}>
      {status.toLowerCase()}
    </Badge>
  );
}
