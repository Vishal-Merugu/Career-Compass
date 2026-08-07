import { Badge } from '@mantine/core';
import type { CampaignStatus, ContactStatus } from '../api/types';

/**
 * Status is one of the few things in this UI that earns a hue, so a colour here
 * means "state", not "category". Both maps live in one file because the
 * campaign list and the campaign detail screen were drifting: the list used a
 * lookup table, the detail page used a three-deep nested ternary that quietly
 * rendered STOPPED as grey while the list rendered it orange.
 *
 * **Nothing here may be amber or orange.** The app's accent is copper-amber, so
 * an orange badge reads as "primary action" rather than as a state — STOPPED
 * was orange and became indistinguishable from the brand the moment the palette
 * changed. STOPPED is now grape: it is the one status a person causes on
 * purpose, and it should not look like a failure or like a pause.
 */
const CAMPAIGN_COLOR: Record<CampaignStatus, string> = {
  PENDING: 'gray',
  SENDING: 'blue',
  COMPLETE: 'teal',
  STOPPED: 'grape',
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
