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
  Checkbox,
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
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type {
  DeleteResponse,
  JobStatusResponse,
  JobsResponse,
  SearchJob,
} from '../api/types';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { EmptyState } from '../components/EmptyState';
import { NewRunModal } from '../components/NewRunModal';
import { StatTile } from '../components/StatTile';
import { TablePager } from '../components/TablePager';
import {
  ACTIVE_STATUSES,
  RESUMABLE_STATUSES,
  statusColor,
  statusLabel,
} from '../lib/runStatus';
import { toast } from '../lib/toast';
import classes from './RunsPage.module.css';

/**
 * Matches the server's default in `server/src/api/jobs.router.ts`.
 *
 * Small for a table, and that is the point: every row on this screen opens its
 * own `/jobs/:id/status` poll, so the page size is also the concurrent-poller
 * count.
 */
const PAGE_SIZE = 25;

/** What each control says once it has actually happened. */
const CONTROL_DONE: Record<'pause' | 'resume' | 'cancel', string> = {
  pause:
    'Run paused. Nothing further is fetched from LinkedIn until you resume.',
  resume: 'Run resumed.',
  cancel: 'Run cancelled. Every queued profile was skipped.',
};

function companyFromUrl(job: SearchJob): string {
  const url = job.searchParams.companyUrl;
  if (!url) return '—';
  // `https://www.linkedin.com/company/acme/` → `acme`, and `/showcase/` the
  // same — a run can target either, so a showcase run must not render as a
  // raw URL in the list.
  const match = /\/(?:company|showcase)\/([^/?#]+)/.exec(url);
  return match ? match[1] : url;
}

function JobRow({
  job,
  selected,
  onToggle,
  onDelete,
}: {
  job: SearchJob;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const active = ACTIVE_STATUSES.has(job.status);

  const { data } = useQuery({
    queryKey: ['job-status', job.id],
    queryFn: () => api.get<JobStatusResponse>(`/api/jobs/${job.id}/status`),
    // Only a running job changes on its own.
    refetchInterval: active ? 3_000 : false,
  });

  // These three had no success feedback and no error feedback whatsoever. The
  // row does eventually re-render from the next poll, but up to 3 s later —
  // long enough to read as a dead button and get pressed again. Errors now go
  // through the global handler in `main.tsx`.
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      api.post(`/api/jobs/${job.id}/${action}`),
    meta: { errorTitle: `Could not change the ${companyFromUrl(job)} run` },
    onSuccess: (_res, action) => {
      toast.success(CONTROL_DONE[action], { id: `run-control-${job.id}` });
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
    <Table.Tr
      className={classes.row}
      data-selected={selected || undefined}
      onClick={open}
    >
      <Table.Td onClick={(e) => e.stopPropagation()}>
        <Checkbox
          size="xs"
          aria-label={`Select the ${companyFromUrl(job)} run`}
          checked={selected}
          onChange={onToggle}
        />
      </Table.Td>

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
                color="gray"
                loading={control.isPending}
                onClick={() => control.mutate('cancel')}
              >
                <IconX size={14} />
              </Button>
            </Tooltip>
          )}
          {/* Red is reserved for the one irreversible action on the row.
              Cancel used to be red too, which put the recoverable action and
              the permanent one in the same colour, side by side. */}
          <Tooltip
            label={
              active
                ? 'Pause or cancel this run before deleting it'
                : 'Delete this run and everything it found'
            }
          >
            {/* A span, so the tooltip still fires on a disabled button —
                which is the case where the label is the whole point. */}
            <span>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                disabled={active}
                onClick={onDelete}
              >
                <IconTrash size={14} />
              </Button>
            </span>
          </Tooltip>
          <IconChevronRight size={14} opacity={0.35} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function RunsPage() {
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The runs the open confirmation is about — one row, or the selection. */
  const [deleting, setDeleting] = useState<string[]>([]);
  const [skip, setSkip] = useState(0);
  const queryClient = useQueryClient();

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['jobs', skip],
    queryFn: () =>
      api.get<JobsResponse>(`/api/jobs?skip=${skip}&take=${PAGE_SIZE}`),
    refetchInterval: 10_000,
    // Without this the table empties to a skeleton on every page change, which
    // for a 10 s-polled list reads as the data having gone away.
    placeholderData: (prev) => prev,
  });

  const jobs = data?.jobs ?? [];
  const total = data?.total ?? 0;
  // From the server, over every run — NOT derived from `jobs`, which is one
  // page. Deriving them would make "Needs attention" mean "needs attention on
  // this page", which is the one reading that makes the tile useless.
  const stats = data?.stats ?? { total: 0, active: 0, needsAttention: 0 };
  const allIds = jobs.map((j) => j.id);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Named from the job list rather than the ids, so the dialog can say which
  // company's run is about to go instead of showing a uuid.
  const doomed = jobs.filter((j) => deleting.includes(j.id));
  const doomedActive = doomed.filter((j) => ACTIVE_STATUSES.has(j.status));

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
          {selected.size > 0 && (
            <>
              <Button
                variant="light"
                color="red"
                leftSection={<IconTrash size={15} />}
                onClick={() => setDeleting([...selected])}
              >
                Delete {selected.size} {selected.size === 1 ? 'run' : 'runs'}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </>
          )}
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
        <StatTile label="Runs" value={stats.total} loading={isPending} />
        <StatTile label="Active now" value={stats.active} loading={isPending} />
        {/* Replaces a total-qualified tile. Only one number here should ever
            prompt an action, and this is it. */}
        <StatTile
          label="Needs attention"
          value={stats.needsAttention}
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
            Press <strong>New run</strong>, paste a LinkedIn company URL, and
            say who counts as a match. The profiles it qualifies land on
            Results.
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
                  <Table.Th w="40px">
                    {/* Scoped to this page — `allIds` is the page, not the
                        account. A selection made on page 1 survives paging
                        away and is still what Delete acts on, which is why
                        the header count above says how many are selected
                        rather than leaving it to be inferred from the rows
                        on screen. */}
                    <Checkbox
                      size="xs"
                      aria-label="Select every run on this page"
                      checked={
                        allIds.length > 0 &&
                        allIds.every((id) => selected.has(id))
                      }
                      indeterminate={
                        allIds.some((id) => selected.has(id)) &&
                        !allIds.every((id) => selected.has(id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.currentTarget.checked ? new Set(allIds) : new Set(),
                        )
                      }
                    />
                  </Table.Th>
                  <Table.Th w="24%">Company</Table.Th>
                  <Table.Th w="15%">Status</Table.Th>
                  <Table.Th w="40%">Progress</Table.Th>
                  <Table.Th w="18%" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    selected={selected.has(job.id)}
                    onToggle={() => toggle(job.id)}
                    onDelete={() => setDeleting([job.id])}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}

        {!isPending && (
          <TablePager
            skip={data?.skip ?? 0}
            take={data?.take ?? PAGE_SIZE}
            total={total}
            loaded={jobs.length}
            noun={['run', 'runs']}
            // Changing page clears the selection deliberately. `doomed` is
            // resolved from the loaded page, so a selection spanning pages
            // would produce a confirmation dialog that names three runs and
            // deletes five — and this dialog's whole job is saying exactly
            // what is about to go.
            onChange={(next) => {
              setSkip(next);
              setSelected(new Set());
            }}
          />
        )}
      </div>

      <NewRunModal opened={newRunOpen} onClose={() => setNewRunOpen(false)} />

      <DeleteConfirmModal
        opened={deleting.length > 0}
        onClose={() => setDeleting([])}
        title={
          deleting.length === 1
            ? 'Delete this run?'
            : `Delete ${deleting.length} runs?`
        }
        confirmLabel={
          deleting.length === 1
            ? 'Delete run'
            : `Delete ${deleting.length} runs`
        }
        // The whole selection is refused if any one of them is working, so the
        // dialog says so up front rather than offering a button that 409s.
        blocked={
          doomedActive.length > 0
            ? `${doomedActive.length === 1 ? 'One of these runs is' : `${doomedActive.length} of these runs are`} still working. Pause or cancel ${doomedActive.length === 1 ? 'it' : 'them'} first — ${doomedActive.map(companyFromUrl).join(', ')}.`
            : undefined
        }
        mutationFn={() =>
          api.del<DeleteResponse>('/api/jobs', { jobIds: deleting })
        }
        onDeleted={() => {
          setSelected(new Set());
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          // Results is scoped by run, so it is stale the moment a run goes.
          void queryClient.invalidateQueries({ queryKey: ['profiles'] });
        }}
      >
        <Stack gap="xs">
          <Text fz={13.5}>
            Everything these runs produced goes with them: the profiles they
            collected, what was read from LinkedIn, every decision the model
            made, and the run log.
          </Text>
          <Text fz={13.5}>
            The people they qualified are removed from <strong>Results</strong>{' '}
            too — unless another run also found them, in which case they stay.
          </Text>
          {doomed.length > 0 && doomed.length <= 8 && (
            <Stack gap={2} mt={2}>
              {doomed.map((job) => (
                <Text key={job.id} fz={13} c="dimmed">
                  · {companyFromUrl(job)} — {job.qualifiedCount} qualified,{' '}
                  {job.totalUrls} collected
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </DeleteConfirmModal>
    </Stack>
  );
}
