import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconEdit,
  IconMail,
  IconPlayerPlay,
  IconPlayerStop,
  IconSparkles,
  IconUsers,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type {
  CampaignContact,
  CampaignDetailResponse,
  CampaignProgress,
  DraftStreamFrame,
} from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { StatTile } from '../components/StatTile';
import {
  CampaignStatusBadge,
  ContactStatusBadge,
} from '../components/StatusBadge';
import { TablePager } from '../components/TablePager';
import { toast } from '../lib/toast';
import classes from './CampaignDetailPage.module.css';

/** Matches the server's default in `server/src/api/campaigns.router.ts`. */
const PAGE_SIZE = 50;

/**
 * Subscribe to the campaign's SSE stream and fold each frame into the cached
 * query data.
 *
 * Patching the cache rather than refetching on every frame: a 200-contact
 * campaign emits three frames per contact, and refetching the whole detail
 * payload each time would be 600 requests.
 */
function useCampaignProgress(
  campaignId: string | undefined,
  live: boolean,
  /**
   * The page currently cached. The contacts query is keyed by it, so the
   * patch below has to target the same entry — a frame for a contact on
   * another page then simply matches nothing, which is correct: that page is
   * refetched from the server when it is opened.
   */
  skip: number,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!campaignId || !live) return;

    const source = new EventSource(`/api/campaigns/${campaignId}/events`, {
      withCredentials: true,
    });

    const key = ['campaign', campaignId, skip];

    source.onmessage = (event: MessageEvent<string>) => {
      let frame: CampaignProgress;
      try {
        frame = JSON.parse(event.data) as CampaignProgress;
      } catch {
        return;
      }

      queryClient.setQueryData<CampaignDetailResponse>(key, (prev) => {
        if (!prev) return prev;

        if (frame.type === 'CONTACT' && frame.contactId) {
          return {
            ...prev,
            contacts: prev.contacts.map((c) =>
              c.id === frame.contactId
                ? {
                    ...c,
                    status: frame.contactStatus ?? c.status,
                    errorMessage: frame.message ?? c.errorMessage,
                  }
                : c,
            ),
          };
        }

        if (frame.type === 'STATS') {
          return {
            ...prev,
            campaign: {
              ...prev.campaign,
              sentCount: frame.sentCount ?? prev.campaign.sentCount,
              failedCount: frame.failedCount ?? prev.campaign.failedCount,
              totalContacts: frame.totalContacts ?? prev.campaign.totalContacts,
            },
          };
        }

        if (frame.type === 'STATUS' && frame.campaignStatus) {
          return {
            ...prev,
            campaign: { ...prev.campaign, status: frame.campaignStatus },
          };
        }

        return prev;
      });
    };

    // EventSource reconnects on its own. The one case it cannot recover from
    // is the server going away entirely, and a refetch on reconnect picks up
    // whatever was missed while it was gone.
    source.onerror = () => {
      void queryClient.invalidateQueries({ queryKey: key });
    };

    return () => source.close();
  }, [campaignId, live, queryClient, skip]);
}

/**
 * Watch the model write this contact's email before anything is sent.
 *
 * The stream persists nothing — it ends with the composed draft in a `done`
 * frame, and saving is still the existing explicit action. Closing the modal
 * mid-stream therefore leaves the campaign sending exactly what it would have
 * sent anyway.
 */
function useDraftStream({
  contactId,
  onChunk,
  onDone,
}: {
  contactId: string | undefined;
  onChunk: (text: string) => void;
  onDone: (subject: string, body: string) => void;
}) {
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  // The callbacks are re-created every render; reading them through a ref
  // keeps `start` stable so it does not tear down a live stream.
  const handlers = useRef({ onChunk, onDone });
  handlers.current = { onChunk, onDone };

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStreaming(false);
  }, []);

  useEffect(() => close, [close, contactId]);

  const start = useCallback(() => {
    if (!contactId) return;
    sourceRef.current?.close();
    setError(null);
    setStreaming(true);

    const source = new EventSource(
      `/api/campaigns/contacts/${contactId}/draft-stream`,
      { withCredentials: true },
    );
    sourceRef.current = source;

    source.onmessage = (event: MessageEvent<string>) => {
      let frame: DraftStreamFrame;
      try {
        frame = JSON.parse(event.data) as DraftStreamFrame;
      } catch {
        return;
      }

      if (frame.type === 'chunk') {
        handlers.current.onChunk(frame.text);
        return;
      }
      if (frame.type === 'done') {
        handlers.current.onDone(frame.subject, frame.body);
      } else {
        setError(frame.message);
      }
      // Closing here is not optional. EventSource reconnects whenever the
      // stream ends, so a finished generation would immediately start a second
      // one and append a whole new email to the first.
      source.close();
      sourceRef.current = null;
      setStreaming(false);
    };

    source.onerror = () => {
      // Only reachable while the stream is still ours: a completed or failed
      // generation clears `sourceRef` above before EventSource can retry.
      if (sourceRef.current !== source) return;
      setError('Lost the connection to the server before the draft finished.');
      source.close();
      sourceRef.current = null;
      setStreaming(false);
    };
  }, [contactId]);

  return { streaming, error, start, cancel: close };
}

function DraftModal({
  contact,
  canGenerate,
  onClose,
}: {
  contact: CampaignContact | null;
  canGenerate: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const {
    streaming,
    error: streamError,
    start,
    cancel,
  } = useDraftStream({
    contactId: contact?.id,
    onChunk: (text) => setBody((prev) => prev + text),
    onDone: (generatedSubject, generatedBody) => {
      setBody(generatedBody);
      // The campaign subject is the fallback the server composed with; only a
      // subject the model actually wrote is worth overwriting the field with.
      if (generatedSubject) setSubject(generatedSubject);
    },
  });

  useEffect(() => {
    setSubject(contact?.customSubject ?? '');
    setBody(contact?.customBody ?? '');
  }, [contact]);

  // Follow the text as it is written, or a long draft streams out of view.
  useEffect(() => {
    if (!streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [body, streaming]);

  const generate = () => {
    if (body.trim().length > 0) {
      const replace = window.confirm(
        'Replace the current draft with a newly generated one?',
      );
      if (!replace) return;
    }
    setBody('');
    start();
  };

  const dismiss = () => {
    cancel();
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/campaigns/contacts/${contact!.id}`, {
        customSubject: subject.trim() || null,
        customBody: body.trim() || null,
      }),
    onSuccess: () => {
      // The modal closes on save, so without this the only evidence anything
      // happened is an "edited" badge on a row that may be off-screen.
      toast.success(
        `Draft saved for ${contact?.name ?? 'this contact'}. It will be sent exactly as written.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['campaign'] });
      onClose();
    },
  });

  return (
    <Modal
      opened={contact !== null}
      onClose={dismiss}
      title={contact ? `Draft for ${contact.name}` : ''}
      size="lg"
      radius="lg"
    >
      <Stack gap="md">
        <Alert color="gray" variant="light" radius="md" fz={13}>
          A saved draft is sent exactly as written — the model is skipped for
          this contact, and nothing further is appended. A generated preview
          already has your signature in it.
        </Alert>
        {streamError && (
          <Alert
            color="red"
            variant="light"
            radius="md"
            fz={13}
            icon={<IconAlertCircle size={16} />}
          >
            {streamError}
          </Alert>
        )}
        <TextInput
          label="Subject"
          placeholder="Leave blank to use the campaign subject"
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
          disabled={streaming}
        />
        <Textarea
          ref={bodyRef}
          label="Body"
          placeholder="Leave blank to let the model write it"
          autosize
          minRows={10}
          maxRows={22}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          readOnly={streaming}
          className={streaming ? classes.streamingBody : undefined}
        />
        <Group justify="space-between" gap="sm">
          <Tooltip
            label={
              canGenerate
                ? 'Watch the model write this email. Nothing is saved until you save it.'
                : 'This campaign has no prompt, so there is nothing to generate from'
            }
            multiline
            maw={260}
          >
            <Box>
              <Button
                variant="light"
                leftSection={<IconSparkles size={15} />}
                onClick={streaming ? cancel : generate}
                disabled={!canGenerate || save.isPending}
              >
                {streaming ? 'Stop' : 'Preview with AI'}
              </Button>
            </Box>
          </Tooltip>
          <Group gap="sm">
            <Button variant="subtle" color="gray" onClick={dismiss}>
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={streaming}
            >
              Save draft
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CampaignContact | null>(null);
  const [skip, setSkip] = useState(0);

  const { data, isPending, error } = useQuery({
    queryKey: ['campaign', id, skip],
    queryFn: () =>
      api.get<CampaignDetailResponse>(
        `/api/campaigns/${id}?skip=${skip}&take=${PAGE_SIZE}`,
      ),
    enabled: Boolean(id),
    // A page change must not blank the whole screen — the campaign header and
    // the stat tiles come from this same query and have not changed.
    placeholderData: (prev) => prev,
  });

  const campaign = data?.campaign;
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const contactsTotal = data?.contactsTotal ?? 0;
  const isSending = campaign?.status === 'SENDING';

  useCampaignProgress(id, isSending, skip);

  // Both of these previously reported nothing at all on success, and the page
  // only catches up when the SSE stream delivers its first frame — so pressing
  // Start and watching a still-PENDING table for a second looked like a
  // no-op. Errors are surfaced by the inline Alert below, which carries a link
  // to Settings when the cause is a missing sending address, so the toast is
  // silenced for them.
  const send = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/send`),
    meta: { silenceErrorToast: true },
    onSuccess: () => {
      toast.success('Sending started. Progress updates live below.');
      void queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    },
  });

  const stop = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/stop`),
    meta: { silenceErrorToast: true },
    onSuccess: () => {
      toast.warning('Sending stopped. Contacts already sent are unaffected.');
      void queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    },
  });

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        icon={<IconAlertCircle size={18} />}
        title="Could not load this campaign"
      >
        <Stack align="flex-start" gap="sm">
          <Text size="sm">{error.message}</Text>
          <Button component={Link} to="/campaigns" size="xs" variant="light">
            Back to campaigns
          </Button>
        </Stack>
      </Alert>
    );
  }

  if (isPending || !campaign) {
    return (
      <Stack gap="xl">
        <Skeleton height={30} width={280} radius="md" />
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
          <Skeleton height={82} radius="lg" />
          <Skeleton height={82} radius="lg" />
          <Skeleton height={82} radius="lg" />
        </SimpleGrid>
        <Skeleton height={280} radius="lg" />
      </Stack>
    );
  }

  const done = campaign.sentCount + campaign.failedCount;
  const pct =
    campaign.totalContacts > 0 ? (done / campaign.totalContacts) * 100 : 0;
  const actionError = send.error ?? stop.error;

  return (
    <Stack gap="xl">
      <Box>
        <Button
          component={Link}
          to="/campaigns"
          variant="subtle"
          color="gray"
          size="compact-sm"
          leftSection={<IconArrowLeft size={14} />}
          mb="xs"
        >
          Campaigns
        </Button>
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <Box>
            <Group gap="sm">
              <Title order={2}>{campaign.name}</Title>
              <CampaignStatusBadge status={campaign.status} size="md" />
            </Group>
            <Text c="dimmed" fz={14} mt={4}>
              {campaign.emailSubject}
            </Text>
          </Box>

          <Group gap="sm">
            {isSending ? (
              <Button
                color="red"
                variant="light"
                leftSection={<IconPlayerStop size={15} />}
                onClick={() => stop.mutate()}
                loading={stop.isPending}
              >
                Stop
              </Button>
            ) : (
              <Button
                leftSection={<IconPlayerPlay size={15} />}
                onClick={() => send.mutate()}
                loading={send.isPending}
                disabled={campaign.totalContacts === 0}
              >
                {done > 0 ? 'Resume sending' : 'Start sending'}
              </Button>
            )}
          </Group>
        </Group>
      </Box>

      {actionError && (
        <Alert
          color="red"
          variant="light"
          radius="lg"
          icon={<IconAlertCircle size={18} />}
          title="Could not start sending"
        >
          <Text fz={13.5}>{actionError.message}</Text>
          {actionError instanceof ApiError &&
            actionError.message.includes('sending address') && (
              <Button
                component={Link}
                to="/settings"
                size="xs"
                variant="light"
                mt="sm"
              >
                Open settings
              </Button>
            )}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="md">
        <StatTile
          label="Contacts"
          value={campaign.totalContacts}
          icon={<IconUsers size={16} />}
        />
        <StatTile
          label="Sent"
          value={campaign.sentCount}
          icon={<IconCheck size={16} />}
        />
        <StatTile
          label="Failed"
          value={campaign.failedCount}
          icon={<IconAlertCircle size={16} />}
        />
      </SimpleGrid>

      {campaign.totalContacts > 0 && (
        <Box>
          <Group justify="space-between" mb={6}>
            <Text fz={13} c="dimmed">
              {done} of {campaign.totalContacts} processed
            </Text>
            {isSending && (
              <Text fz={13} c="dimmed">
                Sending…
              </Text>
            )}
          </Group>
          <Progress
            value={pct}
            size="sm"
            radius="xl"
            animated={isSending}
            color={campaign.failedCount > 0 ? 'red' : 'brand'}
          />
        </Box>
      )}

      <div className={classes.panel}>
        {contactsTotal === 0 ? (
          <EmptyState
            title="No contacts yet"
            icon={<IconMail size={34} stroke={1.4} />}
          >
            Select profiles on the <Link to="/results">Results</Link> screen and
            add them to this campaign.
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
                  <Table.Th w="24%">Name</Table.Th>
                  <Table.Th w="26%">Email</Table.Th>
                  <Table.Th w="20%">Company</Table.Th>
                  <Table.Th w="16%">Status</Table.Th>
                  <Table.Th w="14%">Draft</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {contacts.map((c) => (
                  <Table.Tr key={c.id}>
                    <Table.Td>
                      <Text className={classes.contactName} lineClamp={1}>
                        {c.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <a
                        href={`mailto:${c.email}`}
                        className={classes.emailLink}
                      >
                        {c.email}
                      </a>
                    </Table.Td>
                    <Table.Td>
                      <Text className={classes.company} lineClamp={1}>
                        {c.companyName ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <ContactStatusBadge status={c.status} />
                        {c.errorMessage && (
                          <Tooltip
                            label={c.errorMessage}
                            multiline
                            maw={320}
                            withArrow
                          >
                            <IconAlertCircle
                              size={14}
                              className={classes.errorHint}
                            />
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        {c.customBody ? (
                          <Badge size="xs" variant="light" color="gray">
                            edited
                          </Badge>
                        ) : (
                          <Text fz={12.5} c="dimmed">
                            auto
                          </Text>
                        )}
                        <Tooltip
                          label={
                            c.status === 'SUCCESS'
                              ? 'Already sent'
                              : 'Edit draft'
                          }
                        >
                          {/* Wrapped so the tooltip still fires when the
                              button is disabled — a disabled control emits no
                              pointer events of its own. */}
                          <Box>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              size="sm"
                              className={classes.rowAction}
                              aria-label={`Edit draft for ${c.name}`}
                              onClick={() => setEditing(c)}
                              disabled={c.status === 'SUCCESS'}
                            >
                              <IconEdit size={14} />
                            </ActionIcon>
                          </Box>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}

        <TablePager
          skip={data?.skip ?? 0}
          take={data?.take ?? PAGE_SIZE}
          total={contactsTotal}
          loaded={contacts.length}
          noun={['contact', 'contacts']}
          onChange={setSkip}
        />
      </div>

      <DraftModal
        contact={editing}
        canGenerate={Boolean(campaign.commonPrompt)}
        onClose={() => setEditing(null)}
      />
    </Stack>
  );
}
