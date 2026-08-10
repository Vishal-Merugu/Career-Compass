/**
 * Live view of the finder.
 *
 * Two things changed after a run scraped 368 profiles, qualified none, and
 * looked healthy the whole time:
 *
 * 1. **The bar measures the goal.** It used to fill toward "profiles scraped
 *    out of profiles collected so far" — a denominator that moves, counting a
 *    thing nobody asked for. `0 / 50 qualified` was the real story and it was
 *    the smallest number on the row.
 * 2. **A stopped run says so, in the row.** `failureCode` is denormalised onto
 *    the job precisely so this list can explain itself without a join, because
 *    a paused run rendering identically to a working one is how twenty minutes
 *    went by unnoticed.
 *
 * Still polled rather than streamed: progress is written by workers, so there
 * is no server-side emitter to subscribe to the way campaigns have one.
 */

import { useState } from 'react';
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
  IconAlertTriangle,
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { JobStatusResponse, JobsResponse, SearchJob } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { NewRunModal } from '../components/NewRunModal';
import { StatTile } from '../components/StatTile';
import {
  ACTIVE_STATUSES,
  RESUMABLE_STATUSES,
  needsAttention,
  statusColor,
  statusLabel,
} from '../lib/runStatus';
import classes from './RunsPage.module.css';

function companyFromUrl(job: SearchJob): string {
  const url = job.searchParams.companyUrl;
  if (!url) return '—';
  // `https://www.linkedin.com/company/acme/` → `acme`
  const match = /\/company\/([^/?#]+)/.exec(url);
  return match ? match[1] : url;
}

function JobRow({ job }: { job: SearchJob }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const active = ACTIVE_STATUSES.has(job.status);

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
  const goal = job.limitRequested || 1;
  const goalPct = Math.min(100, (job.qualifiedCount / goal) * 100);

  const open = () => navigate(`/runs/${job.id}`);

  return (
    <Table.Tr className={classes.row} onClick={open}>
      <Table.Td>
        <Text fz={13.5} fw={550} lineClamp={1}>
          {companyFromUrl(job)}
        </Text>
        <Text fz={12} c="dimmed">
          {new Date(job.createdAt).toLocaleString()}
        </Text>
      </Table.Td>

      <Table.Td>
        <Badge size="sm" variant="light" color={statusColor(job.status)}>
          {statusLabel(job.status)}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Stack gap={5}>
          <Progress
            value={goalPct}
            color={job.status === 'completed' ? 'teal' : 'brand'}
            size="sm"
            radius="xl"
          />
          <Text fz={12} c="dimmed">
            {job.qualifiedCount} of {job.limitRequested} qualified
            {collected > 0 && ` · ${scraped}/${collected} read`}
            {stats && stats.erroredCount > 0 && (
              <Text span c="orange" inherit>
                {' '}
                · {stats.erroredCount} not judged
              </Text>
            )}
          </Text>

          {/* The reason, in the row. Not behind a click. */}
          {job.failure && (
            <Group gap={5} wrap="nowrap" align="flex-start">
              <IconAlertTriangle
                size={13}
                style={{ flexShrink: 0, marginTop: 2 }}
                color="var(--mantine-color-orange-6)"
              />
              <Text fz={12} c="orange" lineClamp={2}>
                {job.failure.message} {job.failure.fix}
              </Text>
            </Group>
          )}
        </Stack>
      </Table.Td>

      <Table.Td onClick={(e) => e.stopPropagation()}>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          {ACTIVE_STATUSES.has(job.status) && (
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
          {RESUMABLE_STATUSES.has(job.status) && (
            <Tooltip
              label={
                job.status === 'paused_session'
                  ? 'Resume. This also happens automatically when the extension pushes a fresh LinkedIn session.'
                  : 'Resume. Profiles that were never judged are retried without re-fetching them.'
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
          <IconChevronRight size={14} opacity={0.35} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function RunsPage() {
  const [newRunOpen, setNewRunOpen] = useState(false);

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<JobsResponse>('/api/jobs'),
    refetchInterval: 10_000,
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
  const stuck = jobs.filter((j) => needsAttention(j.status));

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
        <Group gap="sm">
          <Button
            variant="default"
            leftSection={<IconRefresh size={15} />}
            loading={isFetching && !isPending}
            onClick={() => void refetch()}
          >
            Refresh
          </Button>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setNewRunOpen(true)}
          >
            New run
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
        <StatTile label="Runs" value={jobs.length} loading={isPending} />
        <StatTile label="Active now" value={active.length} loading={isPending} />
        {/* Replaces a total-qualified tile. Only one number here should ever
            prompt an action, and this is it. */}
        <StatTile
          label="Needs attention"
          value={stuck.length}
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
            Press <strong>New run</strong>, paste a LinkedIn company URL, and say
            who counts as a match. The profiles it qualifies land on Results.
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
                  <Table.Th w="17%">Status</Table.Th>
                  <Table.Th w="43%">Progress</Table.Th>
                  <Table.Th w="14%" />
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

      <NewRunModal opened={newRunOpen} onClose={() => setNewRunOpen(false)} />
    </Stack>
  );
}
