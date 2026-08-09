/**
 * Live view of the finder.
 *
 * `GET /api/jobs` and `/api/jobs/:id/status` have existed since the scraping
 * pipeline was built and nothing consumed them, so a run in progress was
 * invisible from the dashboard — the only way to watch one was the Telegram bot
 * or the server log. This is that missing screen.
 *
 * Polled rather than streamed: job progress is driven by the extension over
 * WebSocket, so there is no server-side event emitter to subscribe to the way
 * campaigns have one. A three-second poll while a job is active is cheap — the
 * status endpoint is five counts — and it stops entirely once nothing is
 * running.
 */

import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { JobStatusResponse, JobsResponse, SearchJob } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { StatTile } from '../components/StatTile';
import classes from './RunsPage.module.css';

/** Statuses where work is still expected to move. */
const ACTIVE = new Set(['initializing', 'collecting_urls', 'scraping']);

const STATUS_COLOR: Record<string, string> = {
  initializing: 'gray',
  collecting_urls: 'blue',
  scraping: 'brand',
  completed: 'teal',
  paused_error: 'orange',
  // Distinct from paused_error: this one resumes by itself once the extension
  // pushes a fresh LinkedIn session.
  paused_session: 'yellow',
};

/** Statuses the user can resume by hand. */
const RESUMABLE = new Set(['paused_error', 'paused_session']);

function statusLabel(status: string): string {
  if (status === 'paused_session') return 'waiting for LinkedIn session';
  return status.replace(/_/g, ' ');
}

function companyFromUrl(job: SearchJob): string {
  const url = job.searchParams.companyUrl;
  if (!url) return '—';
  // `https://www.linkedin.com/company/acme/` → `acme`
  const match = /\/company\/([^/?#]+)/.exec(url);
  return match ? match[1] : url;
}

function JobRow({ job }: { job: SearchJob }) {
  const queryClient = useQueryClient();
  const active = ACTIVE.has(job.status);

  const { data } = useQuery({
    queryKey: ['job-status', job.id],
    queryFn: () => api.get<JobStatusResponse>(`/api/jobs/${job.id}/status`),
    // Only a running job changes on its own.
    refetchInterval: active ? 3_000 : false,
  });

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      api.post(`/api/jobs/${job.id}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job-status', job.id] });
    },
  });

  const stats = data?.stats;
  const collected = stats?.collectedCount ?? job.totalUrls;
  const scraped = stats?.scrapedCount ?? 0;

  return (
    <Table.Tr>
      <Table.Td>
        <Text fz={13.5} fw={550} lineClamp={1}>
          {companyFromUrl(job)}
        </Text>
        <Text fz={12} c="dimmed">
          {new Date(job.createdAt).toLocaleString()}
        </Text>
      </Table.Td>

      <Table.Td>
        <Badge
          size="sm"
          variant="light"
          color={STATUS_COLOR[job.status] ?? 'gray'}
        >
          {statusLabel(job.status)}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Stack gap={5}>
          <Progress
            value={collected > 0 ? (scraped / collected) * 100 : 0}
            color={active ? 'brand' : 'teal'}
            size="sm"
            radius="xl"
          />
          <Text fz={12} c="dimmed">
            {scraped} of {collected} scraped
            {stats && stats.failedCount > 0 && ` · ${stats.failedCount} failed`}
            {stats &&
              stats.inFlightCount > 0 &&
              ` · ${stats.inFlightCount} in flight`}
          </Text>
        </Stack>
      </Table.Td>

      <Table.Td>
        <Text fz={13}>
          {job.qualifiedCount} / {job.limitRequested}
        </Text>
      </Table.Td>

      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {active && (
            <Tooltip label="Pause">
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                loading={control.isPending}
                onClick={() => control.mutate('pause')}
              >
                <IconPlayerPause size={14} />
              </Button>
            </Tooltip>
          )}
          {RESUMABLE.has(job.status) && (
            <Tooltip
              label={
                job.status === 'paused_session'
                  ? 'Resume. This also happens automatically when the extension pushes a fresh LinkedIn session.'
                  : 'Resume'
              }
            >
              <Button
                size="compact-xs"
                variant="subtle"
                loading={control.isPending}
                onClick={() => control.mutate('resume')}
              >
                <IconPlayerPlay size={14} />
              </Button>
            </Tooltip>
          )}
          {job.status !== 'completed' && (
            <Tooltip label="Cancel — skips every queued profile">
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                loading={control.isPending}
                onClick={() => control.mutate('cancel')}
              >
                <IconX size={14} />
              </Button>
            </Tooltip>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function RunsPage() {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<JobsResponse>('/api/jobs'),
    // Cheap, and it is how a job started from the extension appears here
    // without the user reloading.
    refetchInterval: 10_000,
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  const qualified = jobs.reduce((sum, j) => sum + j.qualifiedCount, 0);

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        icon={<IconAlertCircle size={18} />}
        title="Could not load runs"
      >
        <Stack align="flex-start" gap="sm">
          <Text size="sm">{error.message}</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </Stack>
      </Alert>
    );
  }

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Box>
          <Title order={2}>Runs</Title>
          <Text c="dimmed" fz={14} mt={4}>
            Every finder job, and what it is doing right now.
          </Text>
        </Box>
        <Button
          variant="default"
          leftSection={<IconRefresh size={15} />}
          loading={isFetching && !isPending}
          onClick={() => void refetch()}
        >
          Refresh
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
        <StatTile label="Runs" value={jobs.length} loading={isPending} />
        <StatTile
          label="Active now"
          value={active.length}
          loading={isPending}
        />
        <StatTile
          label="Profiles qualified"
          value={qualified}
          loading={isPending}
        />
      </SimpleGrid>

      <div className={classes.panel}>
        {isPending ? (
          <Stack gap="sm" p="md">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={38} radius="sm" />
            ))}
          </Stack>
        ) : jobs.length === 0 ? (
          <EmptyState title="No runs yet">
            Start a run from the Chrome extension. It will appear here while it
            works, and the profiles it qualifies land on Results.
          </EmptyState>
        ) : (
          <div className={classes.tableWrap}>
            <Table
              verticalSpacing={10}
              horizontalSpacing="md"
              className={classes.table}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w="26%">Company</Table.Th>
                  <Table.Th w="15%">Status</Table.Th>
                  <Table.Th w="32%">Progress</Table.Th>
                  <Table.Th w="14%">Qualified</Table.Th>
                  <Table.Th w="13%" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </div>
    </Stack>
  );
}
