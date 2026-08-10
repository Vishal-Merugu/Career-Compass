/**
 * Starting a run, from the dashboard.
 *
 * This lived in the extension popup, which made it a remote control for work
 * the server does. It also had no idea whether the run could succeed: the user
 * pasted a company URL, pressed start, and found out twenty minutes later that
 * nothing had been configured — if they found out at all.
 *
 * So the preflight runs when the form opens, and Start stays disabled with the
 * reason visible until it passes.
 */

import { useEffect, useState } from 'react';
import {
  Accordion,
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowRight,
  IconCheck,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { FinderSettingsResponse, PreflightResponse } from '../api/types';

interface CreatedJob {
  ok: true;
  jobId: string;
}

/** A company URL we can actually resolve, rather than any URL at all. */
function companyUrlProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Paste a LinkedIn company URL.';
  try {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith('linkedin.com')) {
      return 'That is not a linkedin.com address.';
    }
    if (
      !url.pathname.includes('/company/') &&
      !url.searchParams.get('currentCompany')
    ) {
      return 'Use the company page URL — linkedin.com/company/…';
    }
    return null;
  } catch {
    return 'That does not look like a URL.';
  }
}

export function NewRunModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [companyUrl, setCompanyUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [limit, setLimit] = useState(20);
  const [batchSize, setBatchSize] = useState(100);
  const [touched, setTouched] = useState(false);

  const { data: finder } = useQuery({
    queryKey: ['settings', 'finder'],
    queryFn: () => api.get<FinderSettingsResponse>('/api/settings/finder'),
    enabled: opened,
  });

  // Checked on open rather than on submit, so the blocker is visible before
  // the user has typed anything.
  const { data: preflight, isPending: checking } = useQuery({
    queryKey: ['jobs', 'preflight'],
    queryFn: () => api.get<PreflightResponse>('/api/jobs/preflight'),
    enabled: opened,
  });

  useEffect(() => {
    if (finder && !prompt) setPrompt(finder.settings.searchPrompt);
  }, [finder, prompt]);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedJob>('/api/jobs', {
        limitRequested: limit,
        searchParams: {
          companyUrl: companyUrl.trim(),
          prompt: prompt.trim(),
          batchSize,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onClose();
      setCompanyUrl('');
      setTouched(false);
    },
  });

  const urlProblem = touched ? companyUrlProblem(companyUrl) : null;
  const blocked = preflight ? !preflight.preflight.ok : true;
  const blocker = preflight?.preflight;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="New run"
      size="lg"
      radius="md"
    >
      <Stack gap="md">
        {!checking && blocked && blocker && (
          <Alert
            color="orange"
            variant="light"
            radius="md"
            icon={<IconAlertCircle size={17} />}
            title={blocker.message ?? 'Not ready to run'}
          >
            <Stack align="flex-start" gap="xs">
              <Text fz={13}>{blocker.fix}</Text>
              <Button
                component={Link}
                to="/setup"
                size="xs"
                variant="light"
                color="orange"
                rightSection={<IconArrowRight size={14} />}
              >
                Finish setup
              </Button>
            </Stack>
          </Alert>
        )}

        {!checking && !blocked && (
          <Alert
            color="teal"
            variant="light"
            radius="md"
            icon={<IconCheck size={17} />}
          >
            <Text fz={13}>LinkedIn session and AI model both check out.</Text>
          </Alert>
        )}

        <TextInput
          label="Company"
          description="The LinkedIn company page of the employer you want to reach."
          placeholder="https://www.linkedin.com/company/siemens-healthineers/"
          value={companyUrl}
          onChange={(e) => {
            setCompanyUrl(e.currentTarget.value);
            setTouched(true);
          }}
          error={urlProblem}
        />

        <NumberInput
          label="How many qualified profiles to find"
          description="The run stops as soon as it reaches this. Start small the first time."
          min={1}
          max={500}
          value={limit}
          onChange={(value) => setLimit(Number(value) || 20)}
          w={280}
        />

        <Textarea
          label="Who counts as a match"
          description="Prefilled from your Finder settings. Changing it here affects only this run."
          autosize
          minRows={6}
          maxRows={14}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          styles={{ input: { fontSize: 13, lineHeight: 1.5 } }}
        />

        <Accordion variant="contained" radius="md">
          <Accordion.Item value="advanced">
            <Accordion.Control>
              <Text fz={13.5}>Advanced</Text>
            </Accordion.Control>
            <Accordion.Panel>
              <NumberInput
                label="People to collect per batch"
                description="How many LinkedIn search results to gather before judging any of them."
                min={10}
                max={500}
                value={batchSize}
                onChange={(value) => setBatchSize(Number(value) || 100)}
                w={280}
              />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        {create.error && (
          <Alert
            color="red"
            variant="light"
            radius="md"
            icon={<IconAlertCircle size={17} />}
          >
            {create.error instanceof ApiError
              ? create.error.message
              : 'Could not start the run'}
          </Alert>
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={
              blocked ||
              checking ||
              Boolean(companyUrlProblem(companyUrl)) ||
              !prompt.trim()
            }
          >
            Start run
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
