/**
 * One confirmation dialog for every destructive action in the dashboard.
 *
 * Three things it insists on, all of them because deleting a run is not
 * undoable and the data behind it cost twenty minutes of real LinkedIn calls:
 *
 * 1. **It says what goes, before.** Not "are you sure" — the specific rows.
 * 2. **It says what went, after.** A delete that reports only "done" is
 *    indistinguishable from one that quietly matched nothing, and "nothing is
 *    left behind" is precisely the claim being made.
 * 3. **The destructive button is never the one under the cursor by default.**
 *    Cancel is focused; Delete has to be aimed at.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconTrash } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { DeleteResponse, DeletionSummary } from '../api/types';

/** The counters worth reading, in the order a person would ask about them. */
const LINES: Array<{ key: keyof DeletionSummary; noun: [string, string] }> = [
  { key: 'runs', noun: ['run', 'runs'] },
  { key: 'profiles', noun: ['profile', 'profiles'] },
  { key: 'collectedUrls', noun: ['collected URL', 'collected URLs'] },
  { key: 'scrapedProfiles', noun: ['scraped profile', 'scraped profiles'] },
  { key: 'decisions', noun: ['decision', 'decisions'] },
  { key: 'events', noun: ['log entry', 'log entries'] },
  { key: 'outreachLogs', noun: ['result row', 'result rows'] },
  { key: 'emailLookups', noun: ['email lookup', 'email lookups'] },
  { key: 'companies', noun: ['company', 'companies'] },
  {
    key: 'campaignContactsRemoved',
    noun: ['queued email cancelled', 'queued emails cancelled'],
  },
];

export function summaryLines(summary: DeletionSummary): string[] {
  return LINES.filter(({ key }) => summary[key] > 0).map(({ key, noun }) => {
    const n = summary[key];
    return `${n} ${n === 1 ? noun[0] : noun[1]}`;
  });
}

export function DeleteConfirmModal({
  opened,
  onClose,
  title,
  confirmLabel = 'Delete',
  children,
  blocked,
  mutationFn,
  onDeleted,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  confirmLabel?: string;
  /** What is about to go, in the caller's own words. */
  children: React.ReactNode;
  /**
   * Why this cannot be deleted right now, if it cannot.
   *
   * Set, the destructive button is not rendered at all. The server refuses the
   * same case with a 409, so this is not the check — it is the difference
   * between telling someone the rule and letting them press a button that
   * fails. Never make it the only check.
   */
  blocked?: React.ReactNode;
  mutationFn: () => Promise<DeleteResponse>;
  /** Invalidate queries here. Called once, on success. */
  onDeleted?: (summary: DeletionSummary) => void;
}) {
  const [summary, setSummary] = useState<DeletionSummary | null>(null);

  const remove = useMutation({
    mutationFn,
    onSuccess: (res) => {
      setSummary(res.deleted);
      onDeleted?.(res.deleted);
    },
  });

  // A reopened dialog must not show the previous delete's receipt.
  useEffect(() => {
    if (opened) {
      setSummary(null);
      remove.reset();
    }
    // `remove` is recreated every render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const lines = summary ? summaryLines(summary) : [];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      radius="lg"
      size="md"
      // Closing mid-request would leave the user with no idea whether it ran.
      closeOnClickOutside={!remove.isPending}
      closeOnEscape={!remove.isPending}
    >
      <Stack gap="md">
        {remove.error && (
          <Alert
            color="red"
            variant="light"
            radius="md"
            icon={<IconAlertTriangle size={17} />}
          >
            {remove.error.message}
          </Alert>
        )}

        {summary ? (
          <>
            <Alert
              color="teal"
              variant="light"
              radius="md"
              icon={<IconCheck size={17} />}
              title="Deleted"
            >
              {lines.length === 0 ? (
                <Text fz={13.5}>There was nothing left to remove.</Text>
              ) : (
                <List fz={13.5} spacing={2} withPadding>
                  {lines.map((line) => (
                    <List.Item key={line}>{line}</List.Item>
                  ))}
                </List>
              )}
            </Alert>

            {/* Only mentioned when it happened. A campaign contact that
                survives is a record of mail that really went out, and dropping
                it would erase the only proof of a send. */}
            {summary.campaignContactsKept > 0 && (
              <Text fz={13} c="dimmed">
                {summary.campaignContactsKept} campaign contact
                {summary.campaignContactsKept === 1 ? '' : 's'} kept — those
                emails were already sent, so the record of them stays.
              </Text>
            )}

            <Group justify="flex-end">
              <Button onClick={onClose}>Done</Button>
            </Group>
          </>
        ) : (
          <>
            {children}

            {blocked ? (
              <Alert
                color="orange"
                variant="light"
                radius="md"
                icon={<IconAlertTriangle size={17} />}
              >
                {blocked}
              </Alert>
            ) : (
              <Text fz={13} c="dimmed">
                This cannot be undone.
              </Text>
            )}

            <Group justify="flex-end" gap="sm">
              <Button
                variant="default"
                onClick={onClose}
                disabled={remove.isPending}
                data-autofocus
              >
                {blocked ? 'Close' : 'Cancel'}
              </Button>
              {!blocked && (
                <Button
                  color="red"
                  leftSection={<IconTrash size={15} />}
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {confirmLabel}
                </Button>
              )}
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
