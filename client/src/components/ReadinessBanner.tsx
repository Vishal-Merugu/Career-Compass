/**
 * A standing reminder when the app cannot actually do its job.
 *
 * Deliberately not dismissible-for-good: while a required gate is unmet, every
 * run will be refused, so hiding the reason permanently only moves the
 * confusion later. It can be dismissed for the session, because someone who is
 * mid-way through fixing it does not need to be told twice on every screen.
 */

import { useState } from 'react';
import { Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Link, useLocation } from 'react-router-dom';
import { useSetupStatus } from '../hooks/useSetupStatus';

export function ReadinessBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data } = useSetupStatus();
  const location = useLocation();

  const setup = data?.setup;
  if (!setup || setup.readyToRun || dismissed) return null;

  // Already looking at the fix.
  if (location.pathname === '/setup') return null;

  const blocker = !setup.linkedinSession.ok
    ? { check: setup.linkedinSession, tab: 'linkedin' }
    : { check: setup.aiModel, tab: 'ai' };

  return (
    <Alert
      color="orange"
      variant="light"
      radius="md"
      mb="lg"
      icon={<IconAlertTriangle size={18} />}
      withCloseButton
      onClose={() => setDismissed(true)}
      title={blocker.check.message ?? 'Setup is incomplete'}
    >
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text fz={13.5}>
          {blocker.check.fix} Until then, runs will not start.{' '}
          <Anchor component={Link} to="/setup" fz={13.5}>
            See what is missing
          </Anchor>
          .
        </Text>
        <Button
          component={Link}
          to={`/settings?tab=${blocker.tab}`}
          size="xs"
          variant="light"
          color="orange"
        >
          Fix it
        </Button>
      </Group>
    </Alert>
  );
}
