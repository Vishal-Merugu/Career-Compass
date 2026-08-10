/**
 * Everything about one run.
 *
 * A route rather than a modal, deliberately: it is deep-linkable, it survives
 * a refresh, and there is far more here than a dialog can hold without
 * becoming a scrolling box inside a scrolling page — the config the run
 * actually used, six counters, the event log, and the people it found.
 *
 * The headline number is **qualified out of the target**, not profiles
 * scraped. Scraped-of-collected was the old headline and it measured the wrong
 * thing twice over: the denominator moves as more people are collected, and
 * nobody asked for scraped profiles in the first place.
 */

import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconExternalLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type {
  DeleteResponse,
  JobEventsResponse,
  JobStatusResponse,
} from '../api/types';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { JobEventLog } from '../components/JobEventLog';
import { statusColor, statusLabel } from '../lib/runStatus';
import classes from './RunDetailPage.module.css';

const ACTIVE = new Set(['initializing', 'collecting_urls', 'scraping']);
const RESUMABLE = new Set(['paused_error', 'paused_session']);

function Counter({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: number;
  hint?: string;
  color?: string;
}) {
  const tile = (
    <Paper withBorder radius="md" p="sm">
      <Text fz={22} fw={600} c={color}>
        {value}
      </Text>
      <Text fz={12} c="dimmed" mt={2}>
        {label}
      </Text>
    </Paper>
  );

  return hint ? (
    <Tooltip label={hint} multiline w={240}>
      {tile}
    </Tooltip>
  ) : (
    tile
  );
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  /** This page is *about* the run. Once it is gone, there is nothing to show. */
  const [deleted, setDeleted] = useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: ['job-status', id],
    queryFn: () => api.get<JobStatusResponse>(`/api/jobs/${id}/status`),
    refetchInterval: (query) =>
      ACTIVE.has(query.state.data?.job.status ?? '') ? 3_000 : false,
  });

  const { data: eventsData } = useQuery({
    queryKey: ['job-events', id],
    queryFn: () => api.get<JobEventsResponse>(`/api/jobs/${id}/events`),
    refetchInterval: (query) =>
      ACTIVE.has(data?.job.status ?? '')
        ? 3_000
        : query.state.data
          ? false
          : 5_000,
  });

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      api.post(`/api/jobs/${id}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job-status', id] });
      void queryClient.invalidateQueries({ queryKey: ['job-events', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        title="Could not load this run"
      >
        {error.message}
      </Alert>
    );
  }

  if (isPending || !data) {
    return (
      <Stack gap="lg">
        <Skeleton height={30} width={240} radius="sm" />
        <Skeleton height={120} radius="md" />
        <Skeleton height={280} radius="md" />
      </Stack>
    );
  }

  const { job, stats } = data;
  const active = ACTIVE.has(job.status);
  const company =
    job.configSnapshot?.companyUrl ?? job.searchParams?.companyUrl ?? '';
  const companyName = /\/company\/([^/?#]+)/.exec(company)?.[1] ?? 'this run';
  const goal = job.limitRequested || 1;
  const goalPct = Math.min(100, (job.qualifiedCount / goal) * 100);

  return (
    <Stack gap="xl">
      <Box>
        <Anchor
          component={Link}
          to="/runs"
          fz={13}
          c="dimmed"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <IconArrowLeft size={13} /> All runs
        </Anchor>

        <Group
          justify="space-between"
          align="flex-end"
          mt={6}
          wrap="wrap"
          gap="md"
        >
          <Box>
            <Group gap="sm">
              <Title order={2}>{companyName}</Title>
              <Badge variant="light" color={statusColor(job.status)}>
                {statusLabel(job.status)}
              </Badge>
            </Group>
            <Text c="dimmed" fz={13.5} mt={4}>
              Started {new Date(job.createdAt).toLocaleString()}
              {job.configSnapshot?.llmModel
                ? ` · judged by ${job.configSnapshot.llmModel}`
                : ''}
            </Text>
          </Box>

          <Group gap={6}>
            {active && (
              <Button
                variant="default"
                size="xs"
                leftSection={<IconPlayerPause size={14} />}
                loading={control.isPending}
                onClick={() => control.mutate('pause')}
              >
                Pause
              </Button>
            )}
            {RESUMABLE.has(job.status) && (
              <Button
                size="xs"
                leftSection={<IconPlayerPlay size={14} />}
                loading={control.isPending}
                onClick={() => control.mutate('resume')}
              >
                Resume
              </Button>
            )}
            {job.status !== 'completed' && (
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconX size={14} />}
                loading={control.isPending}
                onClick={() => control.mutate('cancel')}
              >
                Cancel
              </Button>
            )}
            {company && (
              <Button
                variant="subtle"
                size="xs"
                component="a"
                href={company}
                target="_blank"
                rel="noreferrer"
                rightSection={<IconExternalLink size={13} />}
              >
                Company
              </Button>
            )}
            <Button
              variant="subtle"
              color="red"
              size="xs"
              leftSection={<IconTrash size={14} />}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </Group>
        </Group>
      </Box>

      {job.failure && (
        <Alert
          color={job.status === 'paused_session' ? 'yellow' : 'orange'}
          variant="light"
          radius="lg"
          icon={<IconAlertTriangle size={18} />}
          title={job.failure.message}
        >
          <Stack align="flex-start" gap="sm">
            <Text fz={13.5}>{job.failure.fix}</Text>
            {stats.erroredCount > 0 && (
              <Text fz={13}>
                {stats.erroredCount} profile
                {stats.erroredCount === 1 ? '' : 's'} already read from LinkedIn{' '}
                but never judged. Resuming re-judges them without fetching
                anything again.
              </Text>
            )}
            {job.failureDetail && (
              <Code block className={classes.detail}>
                {job.failureDetail}
              </Code>
            )}
          </Stack>
        </Alert>
      )}

      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" align="baseline" mb="xs">
          <Text fw={600} fz={15}>
            {job.qualifiedCount} of {job.limitRequested} profiles qualified
          </Text>
          <Text fz={13} c="dimmed">
            {Math.round(goalPct)}%
          </Text>
        </Group>
        <Progress
          value={goalPct}
          color={job.status === 'completed' ? 'teal' : 'brand'}
          size="lg"
          radius="xl"
        />
        <Text fz={12.5} c="dimmed" mt={8}>
          {stats.scrapedCount} of {stats.collectedCount} collected profiles read
          from LinkedIn
          {stats.remainingCount > 0 &&
            ` · ${stats.remainingCount} still queued`}
        </Text>
      </Paper>

      <SimpleGrid cols={{ base: 2, sm: 3, md: 6 }} spacing="sm">
        <Counter label="Collected" value={stats.collectedCount} />
        <Counter label="Read" value={stats.scrapedCount} />
        <Counter label="Qualified" value={job.qualifiedCount} color="teal" />
        <Counter
          label="Rejected"
          value={stats.rejectedCount}
          hint="The model looked at them and said no. That is a result."
        />
        <Counter
          label="Not judged"
          value={stats.erroredCount}
          color={stats.erroredCount > 0 ? 'orange' : undefined}
          hint="The model never answered for these — unreachable, rate limited, or unreadable output. Resume retries them with no further LinkedIn calls."
        />
        <Counter
          label="Fetch failed"
          value={stats.failedCount}
          hint="LinkedIn would not return the profile."
        />
      </SimpleGrid>

      <Box>
        <Group justify="space-between" align="center" mb="sm">
          <Title order={4}>What happened</Title>
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconRefresh size={13} />}
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: ['job-events', id],
              })
            }
          >
            Refresh
          </Button>
        </Group>
        <Paper withBorder radius="md" className={classes.logPanel}>
          <JobEventLog events={eventsData?.events ?? []} />
        </Paper>
      </Box>

      {job.qualifiedCount > 0 && (
        <Group>
          <Button
            variant="light"
            onClick={() => navigate(`/results?jobId=${id}`)}
          >
            See the {job.qualifiedCount} profiles this run found
          </Button>
          {/* Removing *one* person from this run happens there, on the row.
              The filtered Results table is already the list of this run's
              people, so a second copy of it here would be two screens that
              have to agree. */}
          <Text fz={12.5} c="dimmed">
            Individual profiles can be removed from that list.
          </Text>
        </Group>
      )}

      <DeleteConfirmModal
        opened={deleting}
        // Closing the receipt has nowhere to go back to — this page is about a
        // run that no longer exists, and leaving it up would poll a 404.
        onClose={() => (deleted ? navigate('/runs') : setDeleting(false))}
        title="Delete this run?"
        confirmLabel="Delete run"
        blocked={
          active
            ? 'This run is still working. Pause or cancel it first, then delete it.'
            : undefined
        }
        mutationFn={() => api.del<DeleteResponse>(`/api/jobs/${id}`)}
        onDeleted={() => {
          setDeleted(true);
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          void queryClient.invalidateQueries({ queryKey: ['profiles'] });
        }}
      >
        <Stack gap="xs">
          <Text fz={13.5}>
            {stats.collectedCount} collected profile
            {stats.collectedCount === 1 ? '' : 's'}, {stats.scrapedCount} read
            from LinkedIn, {job.qualifiedCount} qualified and the whole run log
            are deleted.
          </Text>
          <Text fz={13.5}>
            The {job.qualifiedCount} qualified{' '}
            {job.qualifiedCount === 1 ? 'person leaves' : 'people leave'}{' '}
            <strong>Results</strong> too, unless another run also found them.
          </Text>
        </Stack>
      </DeleteConfirmModal>
    </Stack>
  );
}
