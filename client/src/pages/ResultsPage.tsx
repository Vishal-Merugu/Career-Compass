import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Loader,
  Modal,
  Progress,
  Radio,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconBuilding,
  IconExternalLink,
  IconMail,
  IconMailPlus,
  IconMailSearch,
  IconRadar,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type {
  AddContactsResponse,
  Campaign,
  CampaignsResponse,
  DeleteResponse,
  JobsResponse,
  Profile,
  ProfilesResponse,
} from '../api/types';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { ProfileDrawer } from '../components/ProfileDrawer';
import { EmptyState } from '../components/EmptyState';
import { StatTile } from '../components/StatTile';
import { useEmailLookups } from '../hooks/useEmailLookups';
import { useExtensionBridge } from '../hooks/useExtensionBridge';
import { toast } from '../lib/toast';
import { CampaignForm } from './CampaignsPage';
import classes from './ResultsPage.module.css';

/** Matches the server's `take` cap in `server/src/api/profiles.router.ts`. */
const PAGE_SIZE = 100;

/** Which finished lookup batch the user closed the progress panel on. */
const DISMISSED_BATCH_KEY = 'cc.lookups.dismissedBatch';
/** Stand-in id for pre-batch rows, which have none of their own. */
const NO_BATCH = 'legacy';

const COLUMNS = [
  { label: '', width: '40px' },
  { label: 'Name', width: '19%' },
  { label: 'Headline', width: '26%' },
  { label: 'Company', width: '16%' },
  { label: 'Location', width: '15%' },
  { label: 'Email', width: '24%' },
];

function fullName(p: Profile): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

function initials(p: Profile): string {
  const a = p.firstName?.[0] ?? '';
  const b = p.lastName?.[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

/** Matches everything visible in the table, so the filter box is not a lie. */
function matches(p: Profile, needle: string): boolean {
  return [fullName(p), p.headline, p.company?.name, p.location, p.email]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

/**
 * How the address was obtained, in the words the user needs.
 *
 * `emailSource` is a confidence record, not trivia: outreach sends real mail
 * from the user's own Gmail, so a generated guess must be visibly different
 * from an address a provider confirmed. Mirrors
 * `server/src/services/emailFinder/confidence.ts`.
 */
const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  anymailfinder: { label: 'verified', color: 'teal' },
  anymailfinder_web: { label: 'verified', color: 'teal' },
  smtp_verified: { label: 'verified', color: 'teal' },
  mailmeteor: { label: 'provider', color: 'blue' },
  pattern_guess: { label: 'guess', color: 'yellow' },
  not_found: { label: 'not found', color: 'gray' },
};

function sourceBadge(source: string | null) {
  if (!source) return null;
  return SOURCE_LABEL[source] ?? { label: source, color: 'gray' };
}

/**
 * What a pending row is actually doing, which `status` alone does not say.
 *
 * `waiting` and `reclaiming` are the states that stop a closed laptop from
 * looking like work in progress: nothing is running, and the row will resume
 * on its own — the server reclaims an abandoned lease, and a queued row is
 * picked up the moment Chrome comes back.
 */
type LookupState = 'queued' | 'running' | 'waiting' | 'reclaiming';

/**
 * Mirrors `LEASE_TIMEOUT_MS` and `EXTENSION_GRACE_MS` in
 * `server/src/services/emailLookup.service.ts`. Only used to label a row — the
 * server owns the actual transitions, so a small clock skew changes wording,
 * never behaviour.
 */
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const EXTENSION_GRACE_MS = 3 * 60 * 1000;

const LOOKUP_BADGE: Record<
  LookupState,
  { label: string; color: string; spinner: boolean; hint: string }
> = {
  running: {
    label: 'finding',
    color: 'blue',
    spinner: true,
    hint: 'A lookup is running for this profile right now.',
  },
  queued: {
    label: 'queued',
    color: 'gray',
    spinner: true,
    hint: 'Waiting for an executor to pick this up. The extension gets first refusal for three minutes.',
  },
  waiting: {
    label: 'waiting for Chrome',
    color: 'yellow',
    spinner: false,
    hint: 'Nothing is running — no browser has claimed this. It resumes by itself when Chrome is open with the extension, or use "Guess the waiting instead" above.',
  },
  reclaiming: {
    label: 'retrying',
    color: 'orange',
    spinner: false,
    hint: 'The browser that took this never reported back. The server returns it to the queue within a minute and it picks up where it left off.',
  },
};

function TableSkeleton() {
  return (
    <Table
      verticalSpacing={11}
      horizontalSpacing="md"
      className={classes.table}
    >
      <Table.Thead>
        <Table.Tr>
          {COLUMNS.map((c) => (
            <Table.Th key={c.label} w={c.width}>
              {c.label}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {Array.from({ length: 8 }, (_, i) => (
          <Table.Tr key={i}>
            <Table.Td>
              <Skeleton height={14} width={14} radius="sm" />
            </Table.Td>
            <Table.Td>
              <Group gap={10} wrap="nowrap">
                <Skeleton height={30} circle />
                <Skeleton height={9} width={120} radius="xl" />
              </Group>
            </Table.Td>
            <Table.Td>
              <Skeleton height={9} width={200} radius="xl" />
            </Table.Td>
            <Table.Td>
              <Skeleton height={9} width={90} radius="xl" />
            </Table.Td>
            <Table.Td>
              <Skeleton height={9} width={70} radius="xl" />
            </Table.Td>
            <Table.Td>
              <Skeleton height={9} width={130} radius="xl" />
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * Adds the selected profiles to a campaign — existing or newly created.
 *
 * This is what replaces the mailer's CSV round trip: profiles go straight from
 * the pipeline into a campaign, so nothing is exported and re-uploaded.
 */
function AddToCampaignModal({
  profileIds,
  opened,
  onClose,
  onDone,
}: {
  profileIds: string[];
  opened: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');

  const { data } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<CampaignsResponse>('/api/campaigns?take=100'),
    enabled: opened,
  });

  // Finished campaigns are deliberately absent: adding to one would leave it
  // COMPLETE with unsent contacts, which reads as a bug.
  const options = (data?.campaigns ?? [])
    .filter((c) => c.status === 'PENDING' || c.status === 'STOPPED')
    .map((c) => ({ value: c.id, label: `${c.name} (${c.totalContacts})` }));

  const add = useMutation({
    mutationFn: (campaignId: string) =>
      api.post<AddContactsResponse>(`/api/campaigns/${campaignId}/contacts`, {
        profileIds,
      }),
    // `add.error` is rendered at the top of this modal.
    meta: { silenceErrorToast: true },
    onSuccess: (res, campaignId) => {
      // The modal promised "you will be told how many" are skipped, and then
      // navigated away without telling anyone. A duplicate is the common case
      // — adding the same person to a campaign twice is an easy mistake and
      // the server silently drops it.
      const skipped = res.skippedNoEmail + res.skippedDuplicate;
      const detail = [
        res.skippedDuplicate > 0 && `${res.skippedDuplicate} already there`,
        res.skippedNoEmail > 0 && `${res.skippedNoEmail} with no address`,
      ]
        .filter(Boolean)
        .join(', ');

      if (res.added === 0) {
        toast.warning(`Nothing added — ${detail || 'all were skipped'}.`);
      } else if (skipped > 0) {
        toast.success(`${res.added} added, ${skipped} skipped (${detail}).`);
      } else {
        toast.success(
          `${res.added} ${res.added === 1 ? 'contact' : 'contacts'} added.`,
        );
      }

      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      onDone();
      navigate(`/campaigns/${campaignId}`);
    },
  });

  const handleCreated = (campaign: Campaign) => add.mutate(campaign.id);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Add ${profileIds.length} ${profileIds.length === 1 ? 'profile' : 'profiles'} to a campaign`}
      size="lg"
      radius="lg"
    >
      <Stack gap="md">
        {add.error && (
          <Alert
            color="red"
            variant="light"
            radius="md"
            icon={<IconAlertCircle size={17} />}
          >
            {add.error.message}
          </Alert>
        )}

        <Text fz={13.5} c="dimmed">
          Profiles without an email address are skipped — you will be told how
          many.
        </Text>

        <Group gap="xs">
          <Button
            size="xs"
            variant={mode === 'existing' ? 'light' : 'subtle'}
            color={mode === 'existing' ? 'brand' : 'gray'}
            onClick={() => setMode('existing')}
          >
            Existing campaign
          </Button>
          <Button
            size="xs"
            variant={mode === 'new' ? 'light' : 'subtle'}
            color={mode === 'new' ? 'brand' : 'gray'}
            onClick={() => setMode('new')}
          >
            New campaign
          </Button>
        </Group>

        {mode === 'existing' ? (
          <>
            <Select
              label="Campaign"
              placeholder={
                options.length ? 'Choose one' : 'No campaigns available'
              }
              data={options}
              value={target}
              onChange={setTarget}
              disabled={options.length === 0}
              searchable
            />
            <Group justify="flex-end" gap="sm">
              <Button variant="subtle" color="gray" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => target && add.mutate(target)}
                loading={add.isPending}
                disabled={!target}
              >
                Add profiles
              </Button>
            </Group>
          </>
        ) : (
          <CampaignForm onCreated={handleCreated} onCancel={onClose} />
        )}
      </Stack>
    </Modal>
  );
}

export function ResultsPage() {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<Profile | null>(null);
  /** The profiles the open confirmation is about — a row, or the selection. */
  const [deleting, setDeleting] = useState<string[]>([]);
  /**
   * Whether a scoped delete removes the person from this run or from the
   * account. Only asked while the view is filtered to one run, because that is
   * the only time the two differ — and they differ enough to be worth a
   * question rather than a guess.
   */
  const [scope, setScope] = useState<'run' | 'everywhere'>('run');
  const queryClient = useQueryClient();

  // The run filter lives in the URL so a run's detail page can link straight
  // at "the people this run found", and so the scoped view survives a refresh.
  const [params, setParams] = useSearchParams();
  const jobId = params.get('jobId');

  // Feeds the "All runs" filter below, so it wants as many runs as the server
  // will give it in one go rather than the paginated default the Runs screen
  // uses — a run missing from this dropdown cannot be filtered to at all.
  // 100 is the server's cap; past that the Select needs a search endpoint, not
  // a bigger number.
  const { data: runs } = useQuery({
    queryKey: ['jobs', 'filter-options'],
    queryFn: () => api.get<JobsResponse>('/api/jobs?take=100'),
  });
  const {
    stats: lookupStats,
    lookups,
    pending,
    findEmails,
    cancel,
  } = useEmailLookups();

  /**
   * The finished batch the user closed the progress panel on.
   *
   * Kept in `localStorage` rather than state because a finished batch stays
   * finished across reloads — the panel is the record of the last press of
   * "Find emails", and it has nothing else to say once it has been read. A new
   * batch has a new id, so dismissing one never hides the next.
   */
  const [dismissedBatch, setDismissedBatch] = useState<string | null>(() =>
    localStorage.getItem(DISMISSED_BATCH_KEY),
  );
  const dismissBatch = (batchId: string | null) => {
    // Rows queued before batches existed have no id of their own, so they share
    // one stand-in — there is only ever one such group.
    setDismissedBatch(batchId ?? NO_BATCH);
    localStorage.setItem(DISMISSED_BATCH_KEY, batchId ?? NO_BATCH);
  };

  // Only a finished batch can be dismissed, so a dismissal cannot hide work in
  // flight — and the moment a new batch is queued, `batchId` no longer matches.
  const panelDismissed =
    (lookupStats?.pending ?? 0) === 0 &&
    dismissedBatch === (lookupStats?.batchId ?? NO_BATCH);

  // Every pending row is waiting on a browser that is not there. The queue is
  // intact and resumes on its own, but nothing is running — so the panel says
  // that instead of showing a spinner that will never resolve on its own.
  const stalled = pending > 0 && (lookupStats?.stalled ?? 0) >= pending;

  // Which is a different sentence depending on whether a browser that *could*
  // do the work is on the other side of this page. "Waiting for Chrome" is
  // unactionable when Chrome is right here with the extension installed, and it
  // buries the lede when the extension is missing entirely.
  const { state: extension, drainNow } = useExtensionBridge();

  // A backlog plus a live extension is a drain that has not happened yet, and
  // the alarm that would eventually do it is a minute away — long enough that
  // a user watching the panel concludes it is stuck. Poking it is free and
  // idempotent: the drainer refuses a second concurrent run, and the work is
  // claimed under the same server-side lease either way, so nothing here can
  // duplicate a lookup or strand one.
  useEffect(() => {
    if (extension === 'ready' && pending > 0) void drainNow();
  }, [extension, pending, drainNow]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const {
    data,
    isPending,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['profiles', jobId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<ProfilesResponse>(
        `/api/profiles?skip=${pageParam}&take=${PAGE_SIZE}${
          jobId ? `&jobId=${encodeURIComponent(jobId)}` : ''
        }`,
      ),
    getNextPageParam: (last) => {
      const loaded = last.skip + last.profiles.length;
      return loaded < last.total ? loaded : undefined;
    },
  });

  const all = useMemo(
    () => data?.pages.flatMap((page) => page.profiles) ?? [],
    [data],
  );

  // From the server, over the whole result set — NOT derived from `all`, which
  // only holds the pages fetched so far and would understate every tile. The
  // zeroes are placeholders for the first render; the tiles show a skeleton
  // while `isPending`, so they are never displayed.
  const stats = data?.pages[0]?.stats ?? {
    total: 0,
    withEmail: 0,
    companies: 0,
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? all.filter((p) => matches(p, needle)) : all;
  }, [all, filter]);

  // Every visible row is selectable. It used to be only rows with an email,
  // because mailing was the only thing selection fed — but finding an email is
  // now also driven from here, and that is precisely the action you want on a
  // row that has none.
  //
  // Scoped to `visible`, so "select all" while filtered means what it looks
  // like it means rather than quietly selecting rows that are not on screen.
  const selectableIds = useMemo(() => visible.map((p) => p.id), [visible]);

  // Each action applies to a different subset of the selection, so both counts
  // are shown rather than making the user work out which rows will be affected.
  const selectedProfiles = useMemo(
    () => visible.filter((p) => selected.has(p.id)),
    [visible, selected],
  );
  const mailableIds = selectedProfiles.filter((p) => p.email).map((p) => p.id);
  const lookupIds = selectedProfiles.map((p) => p.id);

  // Which rows have a lookup in flight, so the Email column can say so instead
  // of showing an em-dash that looks like a final answer.
  //
  // Four states, not two: a queue that nothing is working has to look different
  // from one that is. A row whose executor vanished (closed laptop) would
  // otherwise spin until the user gave up on it, when in fact the server
  // reclaims the lease within the minute and the row resumes.
  const inFlight = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, LookupState>();

    for (const l of lookups) {
      if (l.status === 'dispatched') {
        const age = now - new Date(l.dispatchedAt ?? l.requestedAt).getTime();
        map.set(l.profileId, age > LEASE_TIMEOUT_MS ? 'reclaiming' : 'running');
      } else if (l.status === 'queued') {
        const age = now - new Date(l.requestedAt).getTime();
        const abandoned = age > EXTENSION_GRACE_MS && !l.allowServerFallback;
        map.set(l.profileId, abandoned ? 'waiting' : 'queued');
      }
    }

    return map;
  }, [lookups]);

  // Rows still waiting on a browser, so the "guess instead" action can re-queue
  // exactly those rather than the current selection.
  const waitingProfileIds = useMemo(
    () => lookups.filter((l) => l.status === 'queued').map((l) => l.profileId),
    [lookups],
  );

  const lastError = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of lookups) {
      if (l.status === 'failed' && l.lastError)
        map.set(l.profileId, l.lastError);
    }
    return map;
  }, [lookups]);

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        icon={<IconAlertCircle size={18} />}
        title="Could not load profiles"
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

  const emailShare =
    stats.total > 0
      ? `${Math.round((stats.withEmail / stats.total) * 100)}% of all profiles`
      : undefined;

  const runOptions = (runs?.jobs ?? []).map((job) => {
    const company =
      /\/company\/([^/?#]+)/.exec(job.searchParams.companyUrl ?? '')?.[1] ??
      'run';
    return {
      value: job.id,
      label: `${company} · ${new Date(job.createdAt).toLocaleDateString()}`,
    };
  });

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Box>
          <Title order={2}>Results</Title>
          <Text c="dimmed" fz={14} mt={4}>
            {jobId
              ? 'Profiles qualified by one run.'
              : 'Every profile scraped and qualified for your account.'}
          </Text>
        </Box>
        <Group gap="sm">
          {/* Results is cross-run by design — it is what campaigns select from
              — so this scopes the view rather than replacing it. */}
          <Select
            size="sm"
            w={260}
            placeholder="All runs"
            clearable
            value={jobId}
            data={runOptions}
            onChange={(value) =>
              setParams(value ? { jobId: value } : {}, { replace: true })
            }
            leftSection={<IconRadar size={15} />}
          />
          <Button
            variant="default"
            leftSection={<IconRefresh size={15} />}
            // `isFetching` is also true while a next page loads; that has its own
            // spinner in the footer and should not spin this button too.
            loading={isFetching && !isPending && !isFetchingNextPage}
            onClick={() => void refetch()}
          >
            Refresh
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
        <StatTile
          label="Profiles"
          value={stats.total}
          icon={<IconUsers size={16} />}
          loading={isPending}
        />
        <StatTile
          label="With an email"
          value={stats.withEmail}
          hint={emailShare}
          icon={<IconMail size={16} />}
          loading={isPending}
        />
        <StatTile
          label="Companies"
          value={stats.companies}
          icon={<IconBuilding size={16} />}
          loading={isPending}
        />
      </SimpleGrid>

      {findEmails.error && (
        <Alert
          color="red"
          variant="light"
          radius="md"
          icon={<IconAlertCircle size={17} />}
          withCloseButton
          onClose={() => findEmails.reset()}
        >
          {findEmails.error.message}
        </Alert>
      )}

      {findEmails.data && findEmails.data.skippedVerified > 0 && (
        <Alert color="gray" variant="light" radius="md">
          Queued {findEmails.data.queued}. {findEmails.data.skippedVerified}{' '}
          already had a verified address and were skipped — re-running those
          would spend a lookup to learn nothing.
        </Alert>
      )}

      {/* Shown whenever the queue is non-empty, including after the tab was
          closed and reopened: the work happens server-side or in the extension,
          so progress advances with nothing watching.

          A finished batch the user closed stays closed — the counts are the
          record of one press of "Find emails", and there is nothing left to
          watch. Work still running is never hidden: dismissing is only offered
          once `pending` hits 0, and the next batch carries a new id. */}
      {lookupStats && lookupStats.total > 0 && !panelDismissed && (
        <Alert
          color={stalled ? 'yellow' : pending > 0 ? 'brand' : 'teal'}
          variant="light"
          radius="lg"
          withCloseButton={pending === 0}
          closeButtonLabel="Dismiss"
          onClose={() => dismissBatch(lookupStats.batchId)}
          icon={
            stalled ? (
              <IconMailSearch size={17} />
            ) : pending > 0 ? (
              <Loader size={16} />
            ) : (
              <IconMail size={17} />
            )
          }
          title={
            stalled
              ? extension === 'ready'
                ? `Picking up ${pending} waiting ${pending === 1 ? 'lookup' : 'lookups'}`
                : extension === 'unlinked'
                  ? `Paused — the extension here is not signed in`
                  : `Paused — no extension in this browser`
              : pending > 0
                ? `Finding emails — ${lookupStats.done + lookupStats.failed} of ${lookupStats.total} done`
                : `Email lookups finished — ${lookupStats.done} found, ${lookupStats.failed} failed`
          }
        >
          <Stack gap="xs">
            <Progress
              value={
                ((lookupStats.done + lookupStats.failed) / lookupStats.total) *
                100
              }
              color={stalled ? 'yellow' : pending > 0 ? 'brand' : 'teal'}
              size="sm"
              radius="xl"
            />
            {pending > 0 && (
              <Stack gap={8}>
                <Text fz={13} c="dimmed">
                  {stalled
                    ? // Nothing is running, and saying so is the point: the queue
                      // is intact and resumes on its own, so the user needs to
                      // know what to do rather than watch a spinner. Which
                      // instruction is useful depends entirely on whether the
                      // extension answered — telling someone to install what
                      // they already have is how a status line stops being read.
                      extension === 'ready'
                      ? 'The extension in this browser has been asked to take these. It works through them a couple at a time; nothing is lost if you close the tab.'
                      : extension === 'unlinked'
                        ? 'The extension is installed here but not signed in, so it cannot claim work. Open it from the toolbar and log in — these resume by themselves after that.'
                        : 'No extension answered in this browser. These need Chrome with the CareerCompass extension installed and signed in — that is the only place the free provider lookup works. They resume by themselves when it is there; nothing was lost.'
                    : 'Keep Chrome open with the extension installed — it does these in a real browser, which is the only place the free provider lookup works. Progress is saved, so you can leave this tab.'}
                </Text>
                <Group gap="sm" wrap="wrap">
                  {waitingProfileIds.length > 0 && (
                    <Tooltip
                      label="Generates the likely address from the name and company domain and verifies it over SMTP. Free and needs no browser, but usually returns an unverified guess — which is why it is not the default."
                      multiline
                      w={300}
                    >
                      <Button
                        size="xs"
                        variant="light"
                        color="yellow"
                        loading={findEmails.isPending}
                        onClick={() =>
                          findEmails.mutate({
                            profileIds: waitingProfileIds,
                            serverFallback: true,
                          })
                        }
                      >
                        {/* Counts the ids actually being sent, not
                            `lookupStats.queued`: the status endpoint returns at
                            most 100 rows, so the two diverge on a large queue
                            and the button would claim to act on more than it
                            does. Also guarded above, since an empty array is a
                            400 from the endpoint. */}
                        Guess the {waitingProfileIds.length} waiting instead
                      </Button>
                    </Tooltip>
                  )}
                  {lookupStats.queued > 0 && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      loading={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Cancel {lookupStats.queued} queued
                    </Button>
                  )}
                </Group>
              </Stack>
            )}
          </Stack>
        </Alert>
      )}

      <div className={classes.panel}>
        <div className={classes.toolbar}>
          <TextInput
            placeholder="Filter by name, company, headline…"
            leftSection={<IconSearch size={15} />}
            rightSection={
              filter ? (
                <CloseButton size="sm" onClick={() => setFilter('')} />
              ) : null
            }
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            w={{ base: '100%', xs: 320 }}
            size="sm"
          />
          {selected.size > 0 && (
            <Group gap={8} wrap="nowrap">
              <Tooltip
                label="Queues a lookup for each selected profile. Profiles that already have a verified address are skipped."
                multiline
                w={260}
              >
                <Button
                  size="sm"
                  variant="light"
                  leftSection={<IconMailSearch size={15} />}
                  loading={findEmails.isPending}
                  onClick={() =>
                    findEmails.mutate(
                      { profileIds: lookupIds },
                      { onSuccess: () => setSelected(new Set()) },
                    )
                  }
                >
                  Find emails ({lookupIds.length})
                </Button>
              </Tooltip>
              <Tooltip
                label="Only profiles with an email can be mailed"
                disabled={mailableIds.length > 0}
              >
                <Button
                  size="sm"
                  leftSection={<IconMailPlus size={15} />}
                  disabled={mailableIds.length === 0}
                  onClick={() => setAdding(true)}
                >
                  Add {mailableIds.length} to campaign
                </Button>
              </Tooltip>
              <Tooltip label="Delete these profiles and everything behind them">
                <Button
                  size="sm"
                  variant="light"
                  color="red"
                  leftSection={<IconTrash size={15} />}
                  onClick={() => setDeleting(lookupIds)}
                >
                  Delete ({lookupIds.length})
                </Button>
              </Tooltip>
              <Button
                size="sm"
                variant="subtle"
                color="gray"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </Group>
          )}
          {!isPending && (
            <Group gap={8} ml="auto" wrap="nowrap">
              {/* The filter runs over loaded rows only. Say so rather than
                  letting "2 of 6" imply the whole set was searched. */}
              {filter.trim() && hasNextPage && (
                <Tooltip label="Only profiles already loaded are searched. Load more to search the rest.">
                  <Badge size="sm" color="gray" style={{ cursor: 'help' }}>
                    partial
                  </Badge>
                </Tooltip>
              )}
              <Text fz={13} c="dimmed">
                {filter.trim()
                  ? `${visible.length} of ${all.length} loaded`
                  : hasNextPage
                    ? `${all.length} of ${stats.total}`
                    : `${stats.total} ${stats.total === 1 ? 'profile' : 'profiles'}`}
              </Text>
            </Group>
          )}
        </div>

        {isPending ? (
          <TableSkeleton />
        ) : stats.total === 0 ? (
          <EmptyState title="No profiles yet">
            Profiles land here once a workflow has run and scraped them. Start a
            run from the Chrome extension.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="No matches">
            Nothing matches “{filter.trim()}” in the{' '}
            {hasNextPage ? `${all.length} profiles loaded so far` : 'results'}.
            {hasNextPage && ' Load more below to widen the search.'}
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
                    <Checkbox
                      size="xs"
                      aria-label="Select all loaded profiles"
                      checked={
                        selectableIds.length > 0 &&
                        selectableIds.every((id) => selected.has(id))
                      }
                      indeterminate={
                        selectableIds.some((id) => selected.has(id)) &&
                        !selectableIds.every((id) => selected.has(id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.currentTarget.checked
                            ? new Set(selectableIds)
                            : new Set(),
                        )
                      }
                    />
                  </Table.Th>
                  {COLUMNS.slice(1).map((c) => (
                    <Table.Th key={c.label} w={c.width}>
                      {c.label}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((p) => (
                  <Table.Tr
                    key={p.id}
                    data-selected={selected.has(p.id) || undefined}
                    className={classes.clickableRow}
                    onClick={() => setDetail(p)}
                  >
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="xs"
                        aria-label={`Select ${fullName(p)}`}
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </Table.Td>
                    <Table.Td>
                      {/* A plain <a>, not Mantine's Anchor: Anchor forces the
                          link colour and would paint every name indigo, which
                          makes the table read as a wall of links. */}
                      <a
                        href={p.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={classes.nameLink}
                      >
                        <Group gap={10} wrap="nowrap">
                          <Avatar
                            size={30}
                            radius="xl"
                            color="brand"
                            variant="light"
                          >
                            <Text fz={11} fw={650}>
                              {initials(p)}
                            </Text>
                          </Avatar>
                          <Text
                            fz={13.5}
                            fw={550}
                            className={classes.nameText}
                            lineClamp={1}
                          >
                            {fullName(p)}
                          </Text>
                          <IconExternalLink
                            size={13}
                            className={classes.linkIcon}
                          />
                        </Group>
                      </a>
                    </Table.Td>

                    <Table.Td>
                      <Text fz={13} c="dimmed" lineClamp={2}>
                        {p.headline ?? '—'}
                      </Text>
                    </Table.Td>

                    <Table.Td>
                      {p.company ? (
                        <Tooltip
                          label={p.company.industry ?? p.company.name}
                          disabled={!p.company.industry}
                        >
                          <Text fz={13} lineClamp={1}>
                            {p.company.name}
                          </Text>
                        </Tooltip>
                      ) : (
                        <Text fz={13} className={classes.dash}>
                          —
                        </Text>
                      )}
                    </Table.Td>

                    <Table.Td>
                      <Text fz={13} c="dimmed" lineClamp={1}>
                        {p.location ?? '—'}
                      </Text>
                    </Table.Td>

                    <Table.Td>
                      {(() => {
                        const searching = inFlight.get(p.id);
                        const badge = sourceBadge(p.emailSource);

                        // A row being looked up right now must not render as an
                        // em-dash — that reads as a settled answer, and the
                        // user would press the button again. It is a badge in
                        // the same shape as the source badge, and it only spins
                        // when something is genuinely running.
                        const state = searching && LOOKUP_BADGE[searching];
                        const lookupBadge = state && (
                          <Tooltip label={state.hint} multiline w={260}>
                            <Badge
                              size="xs"
                              color={state.color}
                              variant="light"
                              style={{ cursor: 'help' }}
                              leftSection={
                                state.spinner ? (
                                  <Loader size={8} color="gray" />
                                ) : undefined
                              }
                            >
                              {state.label}
                            </Badge>
                          </Tooltip>
                        );

                        if (searching && !p.email) {
                          return (
                            <Group gap={7} wrap="nowrap">
                              {lookupBadge}
                            </Group>
                          );
                        }

                        if (p.email) {
                          return (
                            <Group gap={7} wrap="nowrap">
                              <a
                                href={`mailto:${p.email}`}
                                className={classes.emailLink}
                              >
                                {p.email}
                              </a>
                              {badge && (
                                <Tooltip
                                  label={`Source: ${p.emailSource}${
                                    p.emailValidation
                                      ? ` · ${p.emailValidation}`
                                      : ''
                                  }`}
                                >
                                  <Badge size="xs" color={badge.color}>
                                    {badge.label}
                                  </Badge>
                                </Tooltip>
                              )}
                              {/* An address already here can still be a guess
                                  being upgraded — say so, or the spinner in the
                                  header has no visible cause on this row. */}
                              {lookupBadge}
                            </Group>
                          );
                        }

                        const err = lastError.get(p.id);
                        if (err) {
                          return (
                            <Tooltip label={err} multiline w={260}>
                              <Badge
                                size="xs"
                                color="gray"
                                variant="light"
                                style={{ cursor: 'help' }}
                              >
                                not found
                              </Badge>
                            </Tooltip>
                          );
                        }

                        // An em-dash, not a ghost icon — a disabled-looking
                        // button reads as something that ought to work.
                        return (
                          <Text fz={13} className={classes.dash}>
                            —
                          </Text>
                        );
                      })()}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}

        {!isPending && hasNextPage && (
          <div className={classes.tableFooter}>
            <Button
              variant="subtle"
              size="sm"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Load {Math.min(PAGE_SIZE, stats.total - all.length)} more
            </Button>
            <Text fz={12.5} c="dimmed">
              {all.length} of {stats.total} loaded
            </Text>
          </div>
        )}
      </div>

      {/* Only the mailable subset. Selection now also drives email lookups, so
          `selected` can hold rows with no address — passing those would inflate
          the modal's count and then have the server skip them. */}
      <AddToCampaignModal
        profileIds={mailableIds}
        opened={adding}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          setSelected(new Set());
        }}
      />

      <ProfileDrawer
        profile={detail}
        onClose={() => setDetail(null)}
        onDelete={(p) => setDeleting([p.id])}
      />

      <DeleteConfirmModal
        opened={deleting.length > 0}
        onClose={() => setDeleting([])}
        title={
          deleting.length === 1
            ? 'Delete this profile?'
            : `Delete ${deleting.length} profiles?`
        }
        confirmLabel={
          deleting.length === 1 ? 'Delete profile' : `Delete ${deleting.length}`
        }
        mutationFn={() =>
          api.del<DeleteResponse>('/api/profiles', {
            profileIds: deleting,
            // No jobId means "everywhere", which is also the only sane meaning
            // of a delete pressed on the unfiltered table.
            ...(jobId && scope === 'run' ? { jobId } : {}),
          })
        }
        onDeleted={() => {
          setSelected(new Set());
          setDetail(null);
          void queryClient.invalidateQueries({ queryKey: ['profiles'] });
          // Deleting people changes a run's qualified count.
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          void queryClient.invalidateQueries({ queryKey: ['job-status'] });
        }}
      >
        <Stack gap="sm">
          {jobId ? (
            <Radio.Group
              value={scope}
              onChange={(value) => setScope(value as 'run' | 'everywhere')}
              label="How far should this go?"
            >
              <Stack gap={8} mt={8}>
                <Radio
                  value="run"
                  label="Remove from this run only"
                  description="They stay on Results if another run also found them. This run's copy of the scrape and the decision are deleted."
                />
                <Radio
                  value="everywhere"
                  label="Delete from every run"
                  description="Removed from Results entirely, along with every scrape and decision any run holds for them."
                />
              </Stack>
            </Radio.Group>
          ) : (
            <Text fz={13.5}>
              Removed from Results, along with every scrape and decision any run
              holds for them. Runs that found them are otherwise untouched.
            </Text>
          )}

          <Text fz={13.5} c="dimmed">
            Emails already sent stay on their campaign as a record. Anything
            still queued to {deleting.length === 1 ? 'them' : 'these people'} is
            cancelled.
          </Text>
        </Stack>
      </DeleteConfirmModal>
    </Stack>
  );
}
