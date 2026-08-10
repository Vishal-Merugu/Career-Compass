/**
 * Linking a Telegram chat, without putting a permanent credential in it.
 *
 * The bot used to say "send `/link <your_api_key>`, retrieve it from your
 * browser extension configuration settings page". That page is gone, and the
 * API key was the wrong thing to send anyway: it never expires, works from
 * anywhere, and a chat message is a permanent record on someone else's
 * servers. A code from here is good once, for ten minutes.
 */

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Stack,
  Text,
} from '@mantine/core';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { toast } from '../../lib/toast';
import type {
  TelegramCodeResponse,
  TelegramStatusResponse,
} from '../../api/types';

const TELEGRAM_KEY = ['settings', 'telegram'];

export function TelegramSection() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<TelegramCodeResponse | null>(null);

  const { data } = useQuery({
    queryKey: TELEGRAM_KEY,
    queryFn: () => api.get<TelegramStatusResponse>('/api/settings/telegram'),
    // The link completes in another app entirely, so this screen has to notice
    // on its own rather than waiting for a reload.
    refetchInterval: 5_000,
  });

  const telegram = data?.telegram;

  const generate = useMutation({
    mutationFn: () =>
      api.post<TelegramCodeResponse>('/api/settings/telegram/code'),
    onSuccess: (res) => setIssued(res),
  });

  const unlink = useMutation({
    mutationFn: () => api.del('/api/settings/telegram'),
    onSuccess: () => {
      toast.success(
        'Telegram unlinked. No further run notifications are sent.',
      );
      setIssued(null);
      void queryClient.invalidateQueries({ queryKey: TELEGRAM_KEY });
    },
  });

  if (telegram && !telegram.botConfigured) {
    return (
      <Alert
        color="gray"
        variant="light"
        radius="md"
        icon={<IconInfoCircle size={17} />}
      >
        <Text fz={13.5}>
          No Telegram bot is configured on this server, so there is nothing to
          link to. Whoever runs it would need to set{' '}
          <Code>TELEGRAM_BOT_TOKEN</Code>.
        </Text>
      </Alert>
    );
  }

  if (telegram?.linked) {
    return (
      <Stack gap="md" align="flex-start">
        <Alert
          color="teal"
          variant="light"
          radius="md"
          icon={<IconCheck size={17} />}
        >
          <Text fz={13.5}>
            Linked. Runs starting, finishing and pausing will be sent to your
            chat, and you can control them from there.
          </Text>
        </Alert>
        <Button
          variant="default"
          color="red"
          size="xs"
          onClick={() => unlink.mutate()}
          loading={unlink.isPending}
        >
          Unlink this chat
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap="md" align="flex-start">
      <Text fz={13.5} c="dimmed">
        Optional. Get run notifications on your phone, and pause or resume from
        there.
      </Text>

      <List type="ordered" size="sm" spacing={6}>
        <List.Item>Open the CareerCompass bot in Telegram.</List.Item>
        <List.Item>Generate a code below.</List.Item>
        <List.Item>
          Send it to the bot as <Code>/link YOURCODE</Code>.
        </List.Item>
      </List>

      <Button
        onClick={() => generate.mutate()}
        loading={generate.isPending}
        variant={issued ? 'default' : 'filled'}
      >
        {issued ? 'Generate a new code' : 'Generate code'}
      </Button>

      {issued && (
        <Alert color="brand" variant="light" radius="md" w="100%">
          <Group gap="md" align="center">
            <Code fz={20} fw={700} style={{ letterSpacing: 2 }}>
              {issued.code}
            </Code>
            <CopyButton value={`/link ${issued.code}`}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={
                    copied ? <IconCheck size={14} /> : <IconCopy size={14} />
                  }
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy /link command'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Text fz={12.5} c="dimmed" mt={8}>
            Expires in {Math.round(issued.expiresInSeconds / 60)} minutes, and
            works once. This page updates itself when the link goes through.
          </Text>
        </Alert>
      )}

      <Badge variant="light" color="gray" size="sm">
        Never send your API key to a chat
      </Badge>
    </Stack>
  );
}
