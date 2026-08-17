/**
 * The model fallback chain: many keys, tried top to bottom.
 *
 * The screen below this one configures *one* model, which is how this account
 * worked until now — and why a single exhausted free tier could stop a
 * 400-profile run. Here the user stacks as many free tiers as they hold, and
 * the server walks the list until one answers.
 *
 * Two things this screen has to make legible, because they are different
 * problems with different fixes:
 *
 *   - **cooling** — the provider said "not right now". Ours, temporary,
 *     nothing to do. The row is still in the chain, just at the back.
 *   - **disabled** — a wrong key or a wrong model id. A timer cannot fix it,
 *     so the row is out of the chain until the user edits it.
 */

import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconDots,
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { toast } from '../../lib/toast';
import type {
  LlmCredential,
  LlmCredentialCheckResponse,
  LlmCredentialsResponse,
  LlmProvider,
} from '../../api/types';

const CREDENTIALS_KEY = ['settings', 'ai', 'credentials'];

/**
 * Where the free quotas are, in the words of the page the key is copied from.
 *
 * `needsKey` / `needsUrl` drive the form: asking for an API key for a local
 * Ollama, or for an address for Gemini, is how a user ends up entering
 * something plausible into a field that is then ignored.
 */
const PROVIDERS: Array<{
  value: LlmProvider;
  label: string;
  hint: string;
  needsKey: boolean;
  needsUrl: boolean;
  modelPlaceholder: string;
}> = [
  {
    value: 'gemini',
    label: 'Google Gemini',
    hint: 'Key from Google AI Studio. Generous free daily quota.',
    needsKey: true,
    needsUrl: false,
    modelPlaceholder: 'gemini-2.0-flash',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'One key, many models. Model ids ending in :free cost nothing.',
    needsKey: true,
    needsUrl: false,
    modelPlaceholder: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  {
    value: 'groq',
    label: 'Groq',
    hint: 'Free tier, very fast. Key from console.groq.com.',
    needsKey: true,
    needsUrl: false,
    modelPlaceholder: 'llama-3.3-70b-versatile',
  },
  {
    value: 'custom',
    label: 'Other OpenAI-compatible endpoint',
    hint: 'Cloudflare Workers AI, Together, a self-hosted vLLM — anything that serves /chat/completions.',
    needsKey: true,
    needsUrl: true,
    modelPlaceholder: '@cf/meta/llama-3.1-8b-instruct',
  },
  {
    value: 'ollama',
    label: 'Your own Ollama',
    hint: 'Must be reachable from the server, not just from your machine.',
    needsKey: false,
    needsUrl: true,
    modelPlaceholder: 'qwen2.5:14b',
  },
  {
    value: 'server',
    label: 'Built-in model',
    hint: "This server's own model. Nothing to configure.",
    needsKey: false,
    needsUrl: false,
    modelPlaceholder: '',
  },
];

function providerSpec(value: LlmProvider) {
  return PROVIDERS.find((p) => p.value === value) ?? PROVIDERS[0]!;
}

function statusBadge(credential: LlmCredential) {
  switch (credential.status) {
    case 'ready':
      return (
        <Badge color="teal" variant="light" size="sm">
          ready
        </Badge>
      );
    case 'cooling': {
      const until = credential.cooldownUntil
        ? new Date(credential.cooldownUntil)
        : null;
      const minutes = until
        ? Math.max(1, Math.round((until.getTime() - Date.now()) / 60000))
        : null;
      return (
        <Tooltip
          label={
            // The distinction that matters: still in the chain, just last.
            'Hit a limit. Still tried, but after the others — and back to normal once it clears.'
          }
        >
          <Badge color="yellow" variant="light" size="sm">
            {minutes ? `cooling ${minutes}m` : 'cooling'}
          </Badge>
        </Tooltip>
      );
    }
    case 'disabled':
      return (
        <Tooltip label="Needs fixing before it will be used again. Save any edit to re-enable it.">
          <Badge color="red" variant="light" size="sm">
            {credential.disabledCode === 'LLM_AUTH' ? 'bad key' : 'wrong model'}
          </Badge>
        </Tooltip>
      );
    default:
      return (
        <Badge color="gray" variant="light" size="sm">
          off
        </Badge>
      );
  }
}

interface FormState {
  id: string | null;
  label: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  label: '',
  provider: 'gemini',
  model: '',
  baseUrl: '',
  apiKey: '',
};

export function AiFallbackSection() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);

  const { data } = useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () =>
      api.get<LlmCredentialsResponse>('/api/settings/ai/credentials'),
  });

  const credentials = data?.credentials ?? [];

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY });
    // The readiness banner and the New run form both preflight the chain.
    void queryClient.invalidateQueries({ queryKey: ['setup-status'] });
  }

  const save = useMutation({
    mutationFn: (state: FormState) => {
      const spec = providerSpec(state.provider);
      const payload = {
        label: state.label.trim(),
        provider: state.provider,
        model: state.model.trim(),
        baseUrl: spec.needsUrl ? state.baseUrl.trim() : '',
        // Blank means "keep whatever is saved" on an edit, and "no key" on a
        // create. The server never sends a key back, so there is nothing to
        // prefill and nothing to resubmit by accident.
        ...(state.apiKey ? { apiKey: state.apiKey } : {}),
      };

      return state.id
        ? api.patch(`/api/settings/ai/credentials/${state.id}`, payload)
        : api.post('/api/settings/ai/credentials', payload);
    },
    onSuccess: () => {
      toast.success('Model saved.');
      setForm(null);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/settings/ai/credentials/${id}`),
    onSuccess: () => {
      toast.success('Model removed.');
      refresh();
    },
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api.post('/api/settings/ai/credentials/reorder', { ids }),
    onSuccess: refresh,
  });

  const check = useMutation({
    mutationFn: (id: string) =>
      api.post<LlmCredentialCheckResponse>(
        `/api/settings/ai/credentials/${id}/check`,
      ),
    onSuccess: (res) => {
      if (res.check.ok) toast.success(`Answered — ${res.check.detail ?? 'ok'}`);
      else toast.error(res.check.message ?? 'That model did not answer.');
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: (credential: LlmCredential) =>
      api.patch(`/api/settings/ai/credentials/${credential.id}`, {
        enabled: !credential.enabled,
      }),
    onSuccess: refresh,
  });

  function move(index: number, delta: number) {
    const next = [...credentials];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next.map((c) => c.id));
  }

  const spec = form ? providerSpec(form.provider) : null;

  return (
    <Stack gap="md">
      <div>
        <Text fw={600} fz={15}>
          Fallback order
        </Text>
        <Text fz={13} c="dimmed" mt={2}>
          Tried top to bottom. When one hits its rate limit or daily quota, the
          run moves straight to the next instead of stopping — so several free
          tiers add up to one that keeps working.
        </Text>
      </div>

      {credentials.length === 0 && (
        <Alert color="gray" variant="light" radius="md">
          <Text fz={13}>
            No extra models yet. The single model configured below is used on
            its own, and a run stops when it hits a limit.
          </Text>
        </Alert>
      )}

      <Stack gap={8}>
        {credentials.map((credential, index) => (
          <Card key={credential.id} withBorder radius="md" padding="sm">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <Stack gap={2}>
                  <ActionIcon
                    variant="subtle"
                    size="xs"
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                    aria-label="Try this one earlier"
                  >
                    <IconArrowUp size={13} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="xs"
                    disabled={
                      index === credentials.length - 1 || reorder.isPending
                    }
                    onClick={() => move(index, 1)}
                    aria-label="Try this one later"
                  >
                    <IconArrowDown size={13} />
                  </ActionIcon>
                </Stack>

                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text fz={14} fw={500} truncate>
                      {credential.label}
                    </Text>
                    {statusBadge(credential)}
                  </Group>
                  <Text fz={12.5} c="dimmed" truncate>
                    {providerSpec(credential.provider).label}
                    {credential.model ? ` · ${credential.model}` : ''}
                    {credential.successCount > 0
                      ? ` · ${credential.successCount} answered`
                      : ''}
                  </Text>
                </div>
              </Group>

              <Group gap={4} wrap="nowrap">
                <Button
                  size="compact-sm"
                  variant="default"
                  leftSection={<IconPlugConnected size={13} />}
                  loading={check.isPending && check.variables === credential.id}
                  onClick={() => check.mutate(credential.id)}
                >
                  Test
                </Button>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray">
                      <IconDots size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconPencil size={14} />}
                      onClick={() =>
                        setForm({
                          id: credential.id,
                          label: credential.label,
                          provider: credential.provider,
                          model: credential.model,
                          baseUrl: credential.baseUrl,
                          apiKey: '',
                        })
                      }
                    >
                      Edit
                    </Menu.Item>
                    <Menu.Item onClick={() => toggle.mutate(credential)}>
                      {credential.enabled ? 'Turn off' : 'Turn on'}
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => remove.mutate(credential.id)}
                    >
                      Remove
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>

            {credential.status === 'disabled' && (
              <Alert
                color="red"
                variant="light"
                radius="sm"
                mt="xs"
                icon={<IconAlertCircle size={15} />}
              >
                <Text fz={12.5}>
                  {credential.disabledCode === 'LLM_AUTH'
                    ? 'This key was rejected. Edit it and save to put it back in the rotation.'
                    : 'This model id was not found. Edit it and save to put it back in the rotation.'}
                </Text>
              </Alert>
            )}
          </Card>
        ))}
      </Stack>

      <Group>
        <Button
          variant="light"
          leftSection={<IconPlus size={15} />}
          onClick={() => setForm({ ...EMPTY_FORM })}
        >
          Add a model
        </Button>
      </Group>

      <Modal
        opened={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit model' : 'Add a model'}
        radius="md"
      >
        {form && spec && (
          <Stack gap="sm">
            <TextInput
              label="Name"
              description="Yours, so two keys from two accounts are tellable apart."
              placeholder="Gemini — personal account"
              value={form.label}
              onChange={(e) =>
                setForm({ ...form, label: e.currentTarget.value })
              }
            />

            <Select
              label="Provider"
              data={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
              value={form.provider}
              onChange={(value) =>
                setForm({
                  ...form,
                  provider: (value ?? 'gemini') as LlmProvider,
                })
              }
              description={spec.hint}
              allowDeselect={false}
            />

            {spec.needsUrl && (
              <TextInput
                label="Address"
                description="Must be reachable from the server. Inside Docker, localhost is the container itself."
                placeholder="https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1"
                value={form.baseUrl}
                onChange={(e) =>
                  setForm({ ...form, baseUrl: e.currentTarget.value })
                }
              />
            )}

            {spec.needsKey && (
              <PasswordInput
                label="API key"
                description={
                  form.id
                    ? 'Leave blank to keep the saved key.'
                    : 'Stored encrypted, and never sent back to this page.'
                }
                placeholder={form.id ? '••••••••••••' : 'sk-…'}
                value={form.apiKey}
                onChange={(e) =>
                  setForm({ ...form, apiKey: e.currentTarget.value })
                }
              />
            )}

            {form.provider !== 'server' && (
              <TextInput
                label="Model"
                placeholder={spec.modelPlaceholder}
                value={form.model}
                onChange={(e) =>
                  setForm({ ...form, model: e.currentTarget.value })
                }
              />
            )}

            <Group justify="flex-end" mt="xs">
              <Button variant="default" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                loading={save.isPending}
                disabled={!form.label.trim()}
                onClick={() => save.mutate(form)}
              >
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
