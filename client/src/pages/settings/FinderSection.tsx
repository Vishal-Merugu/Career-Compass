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
  Button,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Textarea,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { FinderSettingsResponse } from '../../api/types';

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
      }),
    onSuccess: (res) => queryClient.setQueryData(FINDER_KEY, res),
  });

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
