import { useState } from 'react';
import {
  Alert,
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
import { IconAlertCircle, IconPlus, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Campaign, CampaignsResponse } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { CampaignStatusBadge } from '../components/StatusBadge';
import { TablePager } from '../components/TablePager';
import { toast } from '../lib/toast';
import classes from './CampaignsPage.module.css';

/** Matches the server's default in `server/src/api/campaigns.router.ts`. */
const PAGE_SIZE = 25;

/**
 * What the Prompt field starts with.
 *
 * The operator's own background, deliberately in one constant rather than
 * scattered through the form — this is a single-tenant instance, but the old
 * mailer this was ported from wove one person's identity through
 * `composeDraft` and had to be untangled. Editing the pitch means editing here
 * and nowhere else.
 *
 * It is only an initial value: the field is fully editable, and each campaign
 * stores whatever was submitted.
 */
const DEFAULT_COMMON_PROMPT = `I'm Vishal Merugu, a software and data engineer with 3+ years of production experience — Node.js, TypeScript, Python, AWS and Azure, Docker and Kubernetes — most recently as a Senior Software Engineer at Klenty, a B2B SaaS product serving 100,000+ users. I'm now in Erlangen doing an M.Sc. in Information and Communication Technology at FAU, and I'm looking for working-student, internship or thesis roles in backend, cloud, or data and ML engineering.

VOICE

Write like a sharp engineer emailing another engineer, not like a candidate submitting an application. Dry, a little wry, self-aware about the fact that this is a cold email — that self-awareness is the joke, and it is the only joke. Aim for one line that earns a small exhale of amusement, then get on with it.

The humour is always at my expense or at the situation's, never at theirs and never at their company's. Do not be clever about their work — you know almost nothing about it, and a wrong joke about someone's job is worse than a boring email. If nothing genuinely witty comes from the details you have, write it straight; a plain honest email beats a forced one every time. Never explain or flag the joke.

SUBJECT

Specific enough that it could not have been sent to anyone else — use their actual role, team, stack or company. Short, lower-case, a bit off-beat, the way a real person types a subject when they haven't thought about it too hard. It should read like a note from someone who already works there.

Good: "your platform team, and my unsolicited opinion" / "kubernetes, erlangen, and a favour" / "cold email from a masters student, but a short one"
Bad: "Application for Working Student Position" / "Experienced Software Engineer Seeking Opportunities" / anything with a colon and a value proposition.

BODY — 80 to 120 words, in this order

1. One line saying why I am writing to them specifically, anchored to their actual role, team or company from the details. If the details are thin, say that plainly and with some humour about it, rather than guessing at what their team is "pioneering". Never praise them, never claim I follow their work.
2. One or two lines on me, picking whichever is closest to what they do: backend and cloud infrastructure, data pipelines and A/B experimentation, or LLM evaluation and agent tooling. One concrete detail, not a list of technologies.
3. One line on why that is relevant to their team in particular.
4. Then the ask: working-student, internship or thesis roles, CV attached, and whether they would be open to a short chat.

NEVER

No buzzwords, no "I hope this finds you well", no "I am reaching out", no "passionate", no "synergy", no "I would love to". No self-deprecation that undersells me — wry, not apologetic. No begging, no flattery, no fake urgency, no claim I have used their product. Do not restate my whole background; the CV does that.`;

export function CampaignForm({
  onCreated,
  onCancel,
}: {
  onCreated: (campaign: Campaign) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [commonPrompt, setCommonPrompt] = useState(DEFAULT_COMMON_PROMPT);
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
    // The form renders `create.error` inline, right above the fields it is
    // about. A toast on top of that tells the user the same thing twice.
    meta: { silenceErrorToast: true },
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
      {/* The field people get wrong. "Contact details are added automatically"
          was true and useless — it said what not to write without saying what
          to. What the server injects is now listed under the field, so the only
          question left is what to say about yourself. */}
      <Textarea
        label="Prompt"
        description="How to write each email — who you are and what you are asking for."
        placeholder={`I'm a computer science master's student at FAU Erlangen, looking for a working-student role in backend or ML.

Write a short email, under 120 words:
- open with one concrete line about their team or product
- say what I'm looking for and what I bring
- close by asking if they would be open to a short chat

Plain and direct. No buzzwords, no flattery.`}
        autosize
        minRows={8}
        maxRows={16}
        value={commonPrompt}
        onChange={(e) => setCommonPrompt(e.currentTarget.value)}
      />

      <Text size="xs" c="dimmed" mt={-8}>
        Added for you, so do not ask for them: the recipient&apos;s{' '}
        <b>name, company and role</b>, and your <b>signature</b> and{' '}
        <b>CV attachment</b> from Settings. Write no sign-off — one is appended.
        The model may start with a &ldquo;Subject:&rdquo; line to override the
        fallback subject above.
      </Text>

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
  const [skip, setSkip] = useState(0);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['campaigns', skip],
    queryFn: () =>
      api.get<CampaignsResponse>(
        `/api/campaigns?skip=${skip}&take=${PAGE_SIZE}`,
      ),
    placeholderData: (prev) => prev,
  });

  const campaigns = data?.campaigns ?? [];
  const total = data?.total ?? 0;

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
          <EmptyState title="No campaigns yet">
            Create one here, or select profiles on the{' '}
            <Link to="/results">Results</Link> screen and start a campaign from
            there.
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
                      className={classes.row}
                      onClick={() => navigate(`/campaigns/${c.id}`)}
                    >
                      <Table.Td>
                        {/* A real link, not just a click handler on the row:
                            the row cannot take focus, so without this the
                            screen is unreachable by keyboard. */}
                        <Link
                          to={`/campaigns/${c.id}`}
                          className={classes.nameLink}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Text fz={13.5} fw={550} lineClamp={1} inherit>
                            {c.name}
                          </Text>
                        </Link>
                        <Text fz={12.5} c="dimmed" lineClamp={1}>
                          {c.emailSubject}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <CampaignStatusBadge status={c.status} />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={10} wrap="nowrap">
                          <Progress
                            value={pct}
                            size="sm"
                            radius="xl"
                            className={classes.progressBar}
                            color={c.failedCount > 0 ? 'red' : 'brand'}
                          />
                          <span className={classes.count}>
                            {done}/{c.totalContacts}
                          </span>
                        </Group>
                        {c.failedCount > 0 && (
                          <Text fz={12} c="red.7" mt={3}>
                            {c.failedCount} failed
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <span className={classes.created}>
                          {new Date(c.createdAt).toLocaleString()}
                        </span>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        )}

        {!isPending && (
          <TablePager
            skip={data?.skip ?? 0}
            take={data?.take ?? PAGE_SIZE}
            total={total}
            loaded={campaigns.length}
            noun={['campaign', 'campaigns']}
            onChange={setSkip}
          />
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
            toast.success(
              `“${campaign.name}” created. Add contacts from Results, then start sending.`,
            );
            void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
            navigate(`/campaigns/${campaign.id}`);
          }}
        />
      </Modal>
    </Stack>
  );
}
