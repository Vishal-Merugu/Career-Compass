/**
 * What the run did, in order, in plain sentences.
 *
 * The server keeps this deliberately short — tens of rows for a run of
 * hundreds of profiles — so this component can afford to render all of it
 * without paging or filtering. If it ever needs a filter box, the server's
 * write rate has gone wrong, not this file.
 *
 * Technical detail is present but collapsed. The raw text is what an operator
 * needs on the rare occasion the plain sentence is not enough; leading with it
 * is how logs become unreadable.
 */

import { Badge, Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';
import type { JobEvent } from '../api/types';
import classes from './JobEventLog.module.css';

const STAGE_COLOR: Record<string, string> = {
  run: 'grape',
  collect: 'blue',
  scrape: 'brand',
  qualify: 'teal',
  publish: 'cyan',
  email: 'orange',
};

const LEVEL_COLOR: Record<string, string> = {
  info: 'dimmed',
  warn: 'orange',
  error: 'red',
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function EventRow({ event }: { event: JobEvent }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(event.detail);

  return (
    <Box className={classes.row} data-level={event.level}>
      <Group gap="sm" align="flex-start" wrap="nowrap">
        <Text fz={12} c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
          {time(event.at)}
        </Text>

        <Badge
          size="xs"
          variant="light"
          color={STAGE_COLOR[event.stage] ?? 'gray'}
          style={{ flexShrink: 0, width: 62 }}
        >
          {event.stage}
        </Badge>

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={8} wrap="nowrap" align="baseline">
            <Text
              fz={13.5}
              c={
                LEVEL_COLOR[event.level] === 'dimmed'
                  ? undefined
                  : LEVEL_COLOR[event.level]
              }
              style={{ flex: 1 }}
            >
              {event.message}
            </Text>

            {/* A repeat is a count, never another row. */}
            {event.count > 1 && (
              <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
                ×{event.count}
              </Badge>
            )}
          </Group>

          {event.profileRef && (
            <Text fz={12} c="dimmed" mt={2}>
              {event.profileRef}
            </Text>
          )}

          {hasDetail && (
            <>
              <UnstyledButton
                className={classes.detailToggle}
                onClick={() => setOpen((value) => !value)}
              >
                <Group gap={3}>
                  <IconChevronRight
                    size={12}
                    style={{
                      transform: open ? 'rotate(90deg)' : undefined,
                      transition: 'transform 120ms',
                    }}
                  />
                  <Text fz={12}>{open ? 'Hide' : 'Show'} technical detail</Text>
                </Group>
              </UnstyledButton>
              {open && <Text className={classes.detail}>{event.detail}</Text>}
            </>
          )}
        </Box>
      </Group>
    </Box>
  );
}

export function JobEventLog({ events }: { events: JobEvent[] }) {
  if (events.length === 0) {
    return (
      <Text fz={13.5} c="dimmed" p="md">
        Nothing logged yet.
      </Text>
    );
  }

  return (
    <Stack gap={0}>
      {events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </Stack>
  );
}
