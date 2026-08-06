import { useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  NumberInput,
  Progress,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconInbox,
  IconPlus,
  IconRefresh,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Campaign, CampaignsResponse, CampaignStatus } from '../api/types';
import classes from './ResultsPage.module.css';

/** Colour carries meaning here, so it is one of the few places with a hue. */
const STATUS_COLOR: Record<CampaignStatus, string> = {
  PENDING: 'gray',
  SENDING: 'blue',
  COMPLETE: 'teal',
  STOPPED: 'orange',
  FAILED: 'red',
};

export function CampaignForm({
  onCreated,
  onCancel,
}: {
  onCreated: (campaign: Campaign) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [commonPrompt, setCommonPrompt] = useState('');
  const [minDelayMs, setMinDelayMs] = useState<number>(5000);
  const [maxDelayMs, setMaxDelayMs] = useState<number>(10000);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; campaign: Campaign }>('/api/campaigns', {
        name: name.trim(),
        emailSubject: emailSubject.trim(),
        commonPrompt: commonPrompt.trim() || undefined,
        minDelayMs,
        maxDelayMs,
      }),
    onSuccess: (res) => onCreated(res.campaign),
  });

  const delaysInverted = minDelayMs > maxDelayMs;

  return (
    <Stack gap="md">
      {create.error && (
        <Alert
          color="red"
          variant="light"
          radius="md"
          icon={<IconAlertCircle size={17} />}
        >
          {create.error.message}
        </Alert>
      )}

      <TextInput
        label="Campaign name"
        placeholder="Munich working-student roles"
        description="For your reference only — recipients never see it."
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        required
      />
      <TextInput
        label="Fallback subject"
        placeholder="Working student application"
        description="Used when the model does not write its own Subject: line."
        value={emailSubject}
        onChange={(e) => setEmailSubject(e.currentTarget.value)}
        required
      />
      <Textarea
        label="Prompt"
        description="How to write each email. Contact details are added automatically."
        placeholder="Write a short, specific email introducing me as a working-student candidate…"
        autosize
        minRows={4}
        maxRows={10}
        value={commonPrompt}
        onChange={(e) => setCommonPrompt(e.currentTarget.value)}
      />

      <Group grow align="flex-start">
        <NumberInput
          label="Minimum gap (ms)"
          description="Between sends"
          min={0}
          step={1000}
          value={minDelayMs}
          onChange={(v) => setMinDelayMs(Number(v) || 0)}
        />
        <NumberInput
          label="Maximum gap (ms)"
          description="Randomised in this range"
          min={0}
          step={1000}
          value={maxDelayMs}
          onChange={(v) => setMaxDelayMs(Number(v) || 0)}
          error={delaysInverted ? 'Must be at least the minimum' : undefined}
        />
      </Group>

      <Group justify="flex-end" gap="sm" mt="xs">
        {onCancel && (
          <Button variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={!name.trim() || !emailSubject.trim() || delaysInverted}
        >
          Create campaign
        </Button>
      </Group>
    </Stack>
  );
}

export function CampaignsPage() {
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<CampaignsResponse>('/api/campaigns?take=100'),
  });

  const campaigns = data?.campaigns ?? [];

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        icon={<IconAlertCircle size={18} />}
        title="Could not load campaigns"
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
          <Title order={2}>Campaigns</Title>
          <Text c="dimmed" fz={14} mt={4}>
            Personalised outreach to profiles the pipeline has found.
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
            leftSection={<IconPlus size={15} />}
            onClick={() => setCreating(true)}
          >
            New campaign
          </Button>
        </Group>
      </Group>

      <div className={classes.panel}>
        {isPending ? (
          <Stack p="md" gap="sm">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={38} radius="md" />
            ))}
          </Stack>
        ) : campaigns.length === 0 ? (
          <Stack align="center" py={64} px="md" gap={6}>
            <Box c="dimmed" style={{ opacity: 0.4 }}>
              <IconInbox size={34} stroke={1.4} />
            </Box>
            <Text fw={600} fz={15} mt={6}>
              No campaigns yet
            </Text>
            <Text c="dimmed" fz={13.5} ta="center" maw={400}>
              Create one here, or select profiles on the{' '}
              <Link to="/results">Results</Link> screen and start a campaign
              from there.
            </Text>
          </Stack>
        ) : (
          <div className={classes.tableWrap}>
            <Table
              verticalSpacing={10}
              horizontalSpacing="md"
              className={classes.table}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w="34%">Campaign</Table.Th>
                  <Table.Th w="12%">Status</Table.Th>
                  <Table.Th w="30%">Progress</Table.Th>
                  <Table.Th w="24%">Created</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {campaigns.map((c) => {
                  const done = c.sentCount + c.failedCount;
                  const pct =
                    c.totalContacts > 0 ? (done / c.totalContacts) * 100 : 0;
                  return (
                    <Table.Tr
                      key={c.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/campaigns/${c.id}`)}
                    >
                      <Table.Td>
                        <Text fz={13.5} fw={550} lineClamp={1}>
                          {c.name}
                        </Text>
                        <Text fz={12.5} c="dimmed" lineClamp={1}>
                          {c.emailSubject}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={STATUS_COLOR[c.status]}
                        >
                          {c.status.toLowerCase()}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={10} wrap="nowrap">
                          <Progress
                            value={pct}
                            size="sm"
                            radius="xl"
                            style={{ flex: 1 }}
                            color={c.failedCount > 0 ? 'orange' : 'brand'}
                          />
                          <Text fz={12.5} c="dimmed" w={72} ta="right">
                            {done}/{c.totalContacts}
                          </Text>
                        </Group>
                        {c.failedCount > 0 && (
                          <Text fz={12} c="orange.7" mt={3}>
                            {c.failedCount} failed
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text fz={13} c="dimmed">
                          {new Date(c.createdAt).toLocaleString()}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </div>

      <Modal
        opened={creating}
        onClose={() => setCreating(false)}
        title="New campaign"
        size="lg"
        radius="lg"
      >
        <CampaignForm
          onCancel={() => setCreating(false)}
          onCreated={(campaign) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
            navigate(`/campaigns/${campaign.id}`);
          }}
        />
      </Modal>
    </Stack>
  );
}
