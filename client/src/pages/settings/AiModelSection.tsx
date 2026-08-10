/**
 * Which model judges a profile, and proof that the server can reach it.
 *
 * This screen exists because the equivalent controls lived in the extension,
 * where the "Test AI" button ran the check in the browser's own service worker
 * — reaching the user's laptop rather than the host that makes the real calls.
 * It could report a healthy model while the server could not resolve the
 * address at all. Every check here is performed by the server and says so.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  PasswordInput,
  Radio,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconPlugConnected,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type {
  AiCheckResponse,
  AiSettings,
  AiSettingsResponse,
  LlmProvider,
} from '../../api/types';

const AI_KEY = ['settings', 'ai'];

const PROVIDERS: Array<{
  value: LlmProvider;
  label: string;
  description: string;
}> = [
  {
    value: 'server',
    label: 'Built-in model (recommended)',
    description: 'Runs on this server. Nothing to configure, no API costs.',
  },
  {
    value: 'ollama',
    label: 'Your own Ollama',
    description: 'A model you host. Must be reachable from this server.',
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    description: 'Needs an API key. Billed by Google.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    description: 'Needs an API key. Billed by OpenRouter.',
  },
];

export function AiModelSection() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: AI_KEY,
    queryFn: () => api.get<AiSettingsResponse>('/api/settings/ai'),
  });

  const settings: AiSettings | undefined = data?.settings;

  const [provider, setProvider] = useState<LlmProvider>('server');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  // Blank means "keep the saved key". The server never sends it back, so there
  // is nothing to prefill and nothing to resubmit by accident.
  const [apiKey, setApiKey] = useState('');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!settings || seeded) return;
    setProvider(settings.llmProvider);
    setUrl(settings.llmUrl);
    setModel(settings.llmModel);
    setSeeded(true);
  }, [settings, seeded]);

  const isBuiltIn = provider === 'server';
  const needsUrl = provider === 'ollama';
  const needsKey = provider === 'gemini' || provider === 'openrouter';

  const check = useMutation({
    mutationFn: () =>
      api.post<AiCheckResponse>('/api/settings/ai/check', {
        llmProvider: provider,
        llmUrl: url.trim(),
        llmModel: model.trim(),
        ...(apiKey ? { llmApiKey: apiKey } : {}),
      }),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<AiSettingsResponse>('/api/settings/ai', {
        llmProvider: provider,
        llmUrl: url.trim(),
        llmModel: model.trim(),
        ...(apiKey ? { llmApiKey: apiKey } : {}),
      }),
    onSuccess: (res) => {
      queryClient.setQueryData<AiSettingsResponse>(AI_KEY, res);
      setApiKey('');
      // The banner and the New run form both read this.
      void queryClient.invalidateQueries({ queryKey: ['setup-status'] });
    },
  });

  // Only offered once a check has listed them — a free-text model name is the
  // single most common way to get a 404 that reads as "the AI is broken".
  const discovered = check.data?.models ?? [];
  const result = check.data?.check;

  return (
    <Stack gap="md">
      <Radio.Group
        value={provider}
        onChange={(value) => setProvider(value as LlmProvider)}
      >
        <Stack gap={10}>
          {PROVIDERS.map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.description}
            />
          ))}
        </Stack>
      </Radio.Group>

      {isBuiltIn && settings && (
        <Alert color="gray" variant="light" radius="md">
          <Text fz={13}>
            Using <Code>{settings.builtIn.model}</Code> at{' '}
            <Code>{settings.builtIn.url}</Code>.
          </Text>
          <Text fz={12.5} c="dimmed" mt={4}>
            Set by whoever runs this server. Test it below to confirm it
            answers.
          </Text>
        </Alert>
      )}

      {needsUrl && (
        <TextInput
          label="Address"
          description="Must be reachable from the server, not just from your own machine. Inside Docker, localhost means the container itself — use host.docker.internal."
          placeholder="http://host.docker.internal:11434"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
      )}

      {needsKey && (
        <PasswordInput
          label="API key"
          description={
            settings?.llmApiKeySet
              ? 'A key is saved. Leave blank to keep it, or type a new one to replace it.'
              : 'Stored encrypted, and never sent back to this page.'
          }
          placeholder={settings?.llmApiKeySet ? '••••••••••••' : 'sk-…'}
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
      )}

      {!isBuiltIn &&
        (discovered.length > 0 ? (
          <Select
            label="Model"
            description="Read from the provider just now."
            data={discovered}
            value={model || null}
            onChange={(value) => setModel(value ?? '')}
            searchable
          />
        ) : (
          <TextInput
            label="Model"
            description="Press Test to list what this provider actually has."
            placeholder="qwen2.5:14b"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
          />
        ))}

      <Group gap="sm">
        <Button
          variant="default"
          leftSection={<IconPlugConnected size={15} />}
          loading={check.isPending}
          onClick={() => check.mutate()}
        >
          Test from the server
        </Button>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
        {settings?.llmApiKeySet && needsKey && (
          <Badge color="gray" variant="light" size="sm">
            key saved
          </Badge>
        )}
      </Group>

      {result &&
        (result.ok ? (
          <Alert
            color="teal"
            variant="light"
            radius="md"
            icon={<IconCheck size={17} />}
          >
            <Text fz={13.5}>The server reached the model and it answered.</Text>
            <Text fz={12.5} c="dimmed" mt={2}>
              {result.detail}
            </Text>
          </Alert>
        ) : (
          <Alert
            color="red"
            variant="light"
            radius="md"
            icon={<IconAlertCircle size={17} />}
            title={result.message}
          >
            <Text fz={13}>{result.fix}</Text>
            {result.detail && (
              <Text
                fz={12}
                c="dimmed"
                mt={6}
                style={{ wordBreak: 'break-word' }}
              >
                {result.detail}
              </Text>
            )}
          </Alert>
        ))}
    </Stack>
  );
}
