/**
 * The footer strip under a paginated table.
 *
 * Page-based rather than Results' "Load more", and the difference is not an
 * inconsistency. Results accumulates pages on purpose — its filter box and its
 * "select these, then act on them" flow both run over everything loaded so
 * far, so discarding the previous page would break both. Runs, Campaigns and a
 * campaign's contacts are browsing tables: you want *that* page, and holding
 * the earlier ones costs a poll per run row on the Runs screen.
 *
 * Renders nothing at all when everything fits on one page. A pager under a
 * four-row table is furniture that says "1" and does nothing.
 */

import { Group, Pagination, Text } from '@mantine/core';
import classes from './TablePager.module.css';

export function TablePager({
  skip,
  take,
  total,
  loaded,
  noun = ['item', 'items'],
  onChange,
}: {
  skip: number;
  take: number;
  total: number;
  /** Rows actually on screen — the last page is usually shorter than `take`. */
  loaded: number;
  /** Singular and plural, so the count reads as English. */
  noun?: [string, string];
  /** Called with the new `skip`, not the page number — that is what the API takes. */
  onChange: (skip: number) => void;
}) {
  if (total <= take) return null;

  const pageCount = Math.ceil(total / take);
  const page = Math.floor(skip / take) + 1;
  const first = total === 0 ? 0 : skip + 1;
  const last = skip + loaded;

  return (
    <div className={classes.footer}>
      <Text fz={12.5} c="dimmed">
        {first}–{last} of {total} {total === 1 ? noun[0] : noun[1]}
      </Text>
      <Group gap="xs">
        <Pagination
          size="sm"
          radius="md"
          withEdges
          total={pageCount}
          value={page}
          onChange={(next) => onChange((next - 1) * take)}
        />
      </Group>
    </div>
  );
}
