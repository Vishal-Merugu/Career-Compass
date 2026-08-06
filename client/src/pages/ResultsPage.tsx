import { useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
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
  IconInbox,
  IconMail,
  IconRefresh,
  IconSearch,
  IconUsers,
} from '@tabler/icons-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Profile, ProfilesResponse } from '../api/types';
import { StatTile } from '../components/StatTile';
import classes from './ResultsPage.module.css';

/** Matches the server's `take` cap in `server/src/api/profiles.router.ts`. */
const PAGE_SIZE = 100;

const COLUMNS = [
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

function EmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Stack align="center" py={64} px="md" gap={6}>
      <Box c="dimmed" style={{ opacity: 0.4 }}>
        <IconInbox size={34} stroke={1.4} />
      </Box>
      <Text fw={600} fz={15} mt={6}>
        {title}
      </Text>
      <Text c="dimmed" fz={13.5} ta="center" maw={380}>
        {children}
      </Text>
    </Stack>
  );
}

export function ResultsPage() {
  const [filter, setFilter] = useState('');

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
    queryKey: ['profiles'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<ProfilesResponse>(
        `/api/profiles?skip=${pageParam}&take=${PAGE_SIZE}`,
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

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Box>
          <Title order={2}>Results</Title>
          <Text c="dimmed" fz={14} mt={4}>
            Every profile scraped and qualified for your account.
          </Text>
        </Box>
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
                  {COLUMNS.map((c) => (
                    <Table.Th key={c.label} w={c.width}>
                      {c.label}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((p) => (
                  <Table.Tr key={p.id}>
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
                      {p.email ? (
                        <Group gap={7} wrap="nowrap">
                          <a
                            href={`mailto:${p.email}`}
                            className={classes.emailLink}
                          >
                            {p.email}
                          </a>
                          {p.emailValidation && (
                            <Badge
                              size="xs"
                              color={
                                p.emailValidation === 'valid' ? 'teal' : 'gray'
                              }
                            >
                              {p.emailValidation}
                            </Badge>
                          )}
                        </Group>
                      ) : (
                        // An em-dash, not a ghost icon — a disabled-looking
                        // button reads as something that ought to work.
                        <Text fz={13} className={classes.dash}>
                          —
                        </Text>
                      )}
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
    </Stack>
  );
}
