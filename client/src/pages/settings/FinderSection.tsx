/**
 * Defaults for a new run, plus the two knobs the mass connector still reads.
 *
 * The criteria prompt used to be the default text of a `<textarea>` in the
 * extension popup — not editable without editing markup, and lost entirely
 * when the finder moved to the dashboard.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Group,
  NumberInput,
  PasswordInput,
  Stack,
  Switch,
  Text,
  Textarea,
} from '@mantine/core';
import { IconCheck, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { toast } from '../../lib/toast';
import type {
  FinderSettingsResponse,
  LinkFinderCheckResponse,
  LookupResumeResponse,
} from '../../api/types';

const FINDER_KEY = ['settings', 'finder'];

export function FinderSection() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: FINDER_KEY,
    queryFn: () => api.get<FinderSettingsResponse>('/api/settings/finder'),
  });

  const settings = data?.settings;

  const [prompt, setPrompt] = useState('');
  const [dailyLimit, setDailyLimit] = useState(15);
  const [emailFinderEnabled, setEmailFinderEnabled] = useState(true);
  const [seeded, setSeeded] = useState(false);

  // Never seeded from the server — the key is write-only, and `settings` only
  // carries `linkFinderApiKeySet`. Empty means "leave whatever is stored
  // alone", which is why saving is not a way to accidentally clear a key.
  const [linkFinderKey, setLinkFinderKey] = useState('');

  useEffect(() => {
    if (!settings || seeded) return;
    setPrompt(settings.searchPrompt);
    setDailyLimit(settings.dailyLimit);
    setEmailFinderEnabled(settings.emailFinderEnabled);
    setSeeded(true);
  }, [settings, seeded]);

  const save = useMutation({
    mutationFn: () =>
      api.put<FinderSettingsResponse>('/api/settings/finder', {
        searchPrompt: prompt.trim() || null,
        dailyLimit,
        emailFinderEnabled,
        // Omitted entirely when the box is empty. Sending `null` would clear a
        // stored key, and the box is empty on every page load.
        ...(linkFinderKey.trim()
          ? { linkFinderApiKey: linkFinderKey.trim() }
          : {}),
      }),
    onSuccess: (res) => {
      toast.success('Finder settings saved. They apply to the next run.');
      queryClient.setQueryData(FINDER_KEY, res);
      setLinkFinderKey('');
    },
  });

  const clearKey = useMutation({
    mutationFn: () =>
      api.put<FinderSettingsResponse>('/api/settings/finder', {
        linkFinderApiKey: null,
      }),
    onSuccess: (res) => {
      toast.success(
        'LinkFinder key removed. Lookups go straight to the extension.',
      );
      queryClient.setQueryData(FINDER_KEY, res);
      setLinkFinderKey('');
    },
  });

  const check = useMutation({
    mutationFn: () =>
      api.post<LinkFinderCheckResponse>(
        '/api/settings/finder/linkfinder/check',
        linkFinderKey.trim() ? { apiKey: linkFinderKey.trim() } : {},
      ),
    onSuccess: (res) => {
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      void queryClient.invalidateQueries({ queryKey: FINDER_KEY });
    },
  });

  const resume = useMutation({
    mutationFn: () =>
      api.post<LookupResumeResponse>('/api/profiles/find-emails/resume', {}),
    onSuccess: () => {
      toast.success('LinkFinder resumed. Held lookups start again now.');
      void queryClient.invalidateQueries({ queryKey: FINDER_KEY });
    },
  });

  const linkFinder = settings?.linkFinder;

  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Textarea
          label="Default criteria for a new run"
          description="How the model decides whether someone is worth reaching out to. Every run starts with a copy of this and can change it."
          autosize
          minRows={8}
          maxRows={20}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          styles={{ input: { fontSize: 13, lineHeight: 1.5 } }}
        />
        {settings?.usingDefaultPrompt && (
          <Text fz={12} c="dimmed">
            Currently the built-in default. Editing it makes it yours; clearing
            the box restores the default.
          </Text>
        )}
      </Stack>

      <NumberInput
        label="Connection requests per day"
        description="LinkedIn's own ceiling is around 15–20. Going higher gets accounts restricted, not results."
        min={1}
        max={100}
        value={dailyLimit}
        onChange={(value) => setDailyLimit(Number(value) || 15)}
        w={280}
      />

      <Switch
        label="Look up work emails"
        description="Runs in the extension when you press “Find emails” on Results."
        checked={emailFinderEnabled}
        onChange={(e) => setEmailFinderEnabled(e.currentTarget.checked)}
      />

      <Divider />

      <Stack gap={6}>
        <Group gap="xs">
          <Text fw={600} fz={14}>
            LinkFinder
          </Text>
          {settings?.linkFinderApiKeySet ? (
            linkFinder?.paused ? (
              <Badge color="yellow" variant="light" size="sm">
                Paused
              </Badge>
            ) : (
              <Badge color="teal" variant="light" size="sm">
                Active
              </Badge>
            )
          ) : (
            <Badge color="gray" variant="light" size="sm">
              Not set up
            </Badge>
          )}
        </Group>

        <Text fz={13} c="dimmed">
          Your own{' '}
          <Anchor href="https://linkfinderai.com" target="_blank" fz={13}>
            LinkFinder
          </Anchor>{' '}
          API key. With one saved, “Find emails” resolves each profile straight
          from its LinkedIn URL before any browser is involved — a credit per
          lookup, from your balance. Anyone it cannot find is held for you to
          send to the extension by hand. Without a key, every lookup goes to the
          extension as before.
        </Text>

        <PasswordInput
          label="API key"
          description={
            settings?.linkFinderApiKeySet
              ? 'A key is saved. Type a new one to replace it; leaving this empty keeps it.'
              : 'From your LinkFinder dashboard, under Settings → API Key.'
          }
          placeholder={
            settings?.linkFinderApiKeySet ? '••••••••••••' : 'lf_...'
          }
          value={linkFinderKey}
          onChange={(e) => setLinkFinderKey(e.currentTarget.value)}
          autoComplete="off"
          maw={480}
        />

        <Group gap="xs" mt={4}>
          <Button
            size="xs"
            variant="default"
            loading={check.isPending}
            disabled={!linkFinderKey.trim() && !settings?.linkFinderApiKeySet}
            onClick={() => check.mutate()}
          >
            Test key (uses 1 credit)
          </Button>
          {settings?.linkFinderApiKeySet && (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              loading={clearKey.isPending}
              onClick={() => clearKey.mutate()}
            >
              Remove key
            </Button>
          )}
        </Group>
        <Text fz={12} c="dimmed">
          LinkFinder bills every request, including ones that find nothing, and
          has no free way to validate a key — so testing one really does spend a
          credit.
        </Text>
      </Stack>

      {linkFinder?.paused && (
        <Alert
          color="yellow"
          variant="light"
          radius="md"
          title={linkFinder.title}
        >
          <Stack gap="sm">
            <Text fz={13}>{linkFinder.message}</Text>
            {linkFinder.detail && (
              <Text fz={12} c="dimmed">
                {linkFinder.detail}
              </Text>
            )}
            <Group>
              <Button
                size="xs"
                leftSection={<IconPlayerPlay size={14} />}
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >
                Resume LinkFinder
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      <Group>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
        {save.isSuccess && (
          <Group gap={5}>
            <IconCheck size={15} color="var(--mantine-color-teal-6)" />
            <Text fz={13} c="dimmed">
              Saved
            </Text>
          </Group>
        )}
      </Group>

      {save.error && (
        <Alert color="red" variant="light" radius="md">
          {save.error.message}
        </Alert>
      )}
    </Stack>
  );
}
