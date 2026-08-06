import { useEffect, useMemo, useState } from 'react';
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
  IconUsers,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type {
  CampaignContact,
  CampaignDetailResponse,
  CampaignProgress,
} from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { StatTile } from '../components/StatTile';
import {
  CampaignStatusBadge,
  ContactStatusBadge,
} from '../components/StatusBadge';
import classes from './CampaignDetailPage.module.css';

/**
 * Subscribe to the campaign's SSE stream and fold each frame into the cached
 * query data.
 *
 * Patching the cache rather than refetching on every frame: a 200-contact
 * campaign emits three frames per contact, and refetching the whole detail
 * payload each time would be 600 requests.
 */
function useCampaignProgress(campaignId: string | undefined, live: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!campaignId || !live) return;

    const source = new EventSource(`/api/campaigns/${campaignId}/events`, {
      withCredentials: true,
    });

    const key = ['campaign', campaignId];

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
  }, [campaignId, live, queryClient]);
}

function DraftModal({
  contact,
  onClose,
}: {
  contact: CampaignContact | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    setSubject(contact?.customSubject ?? '');
    setBody(contact?.customBody ?? '');
  }, [contact]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/campaigns/contacts/${contact!.id}`, {
        customSubject: subject.trim() || null,
        customBody: body.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign'] });
      onClose();
    },
  });

  return (
    <Modal
      opened={contact !== null}
      onClose={onClose}
      title={contact ? `Draft for ${contact.name}` : ''}
      size="lg"
      radius="lg"
    >
      <Stack gap="md">
        <Alert color="gray" variant="light" radius="md" fz={13}>
          A saved draft is sent exactly as written — the model is skipped for
          this contact, and the signature is not appended.
        </Alert>
        <TextInput
          label="Subject"
          placeholder="Leave blank to use the campaign subject"
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
        />
        <Textarea
          label="Body"
          placeholder="Leave blank to let the model write it"
          autosize
          minRows={10}
          maxRows={22}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save draft
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CampaignContact | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<CampaignDetailResponse>(`/api/campaigns/${id}`),
    enabled: Boolean(id),
  });

  const campaign = data?.campaign;
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const isSending = campaign?.status === 'SENDING';

  useCampaignProgress(id, isSending);

  const send = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/send`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  });

  const stop = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/stop`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
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
            color={campaign.failedCount > 0 ? 'orange' : 'brand'}
          />
        </Box>
      )}

      <div className={classes.panel}>
        {contacts.length === 0 ? (
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
      </div>

      <DraftModal contact={editing} onClose={() => setEditing(null)} />
    </Stack>
  );
}
