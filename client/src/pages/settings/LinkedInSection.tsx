/**
 * The LinkedIn session, and the only honest place to explain the extension.
 *
 * The server cannot log in to LinkedIn — there is no password flow, and a
 * headless browser on a datacenter-adjacent IP is exactly what the risk engine
 * looks for. So the cookie jar always comes from a real browser, and "open the
 * extension occasionally" is a genuine operational requirement rather than a
 * quirk. If it lapses, every run pauses.
 */

import {
  Alert,
  Anchor,
  Badge,
  Code,
  Group,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { SessionResponse } from '../../api/types';

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function LinkedInSection() {
  const { data, isPending } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/api/session'),
    refetchInterval: 30_000,
  });

  if (isPending) return <Skeleton height={72} radius="md" />;

  const session = data?.session;
  const healthy = session?.present && session.isValid;

  return (
    <Stack gap="md">
      {healthy ? (
        <Alert
          color="teal"
          variant="light"
          radius="md"
          icon={<IconCheck size={17} />}
        >
          <Group gap="sm">
            <Text fz={13.5}>Connected to LinkedIn.</Text>
            <Badge size="sm" variant="light" color="gray">
              {session.importedAt
                ? `updated ${relative(session.importedAt)}`
                : 'active'}
            </Badge>
          </Group>
          <Text fz={12.5} c="dimmed" mt={4}>
            The extension refreshes this every 30 minutes while Chrome is open.
          </Text>
        </Alert>
      ) : (
        <Alert
          color={session?.present ? 'orange' : 'gray'}
          variant="light"
          radius="md"
          icon={<IconAlertCircle size={17} />}
          title={
            session?.present
              ? 'The LinkedIn session has expired'
              : 'Not connected to LinkedIn yet'
          }
        >
          <Text fz={13}>
            Open the CareerCompass Chrome extension in a tab where you are
            logged in to LinkedIn. It sends the session here automatically —
            there is nothing to copy or paste.
          </Text>
          {session?.invalidReason && (
            <Text fz={12} c="dimmed" mt={6}>
              {session.invalidReason}
            </Text>
          )}
          {session?.missingCritical?.length ? (
            <Text fz={12} c="dimmed" mt={6}>
              Missing: <Code>{session.missingCritical.join(', ')}</Code>
            </Text>
          ) : null}
        </Alert>
      )}

      <Text fz={13} c="dimmed">
        Runs happen on the server, so your browser does not need to stay open
        while one is going. The extension is only how a valid session reaches
        the server — and how emails are looked up and connection requests are
        sent, both of which need a real browser. See{' '}
        <Anchor
          fz={13}
          href="https://www.linkedin.com/feed/"
          target="_blank"
          rel="noreferrer"
        >
          linkedin.com
        </Anchor>
        .
      </Text>
    </Stack>
  );
}
