/**
 * What a new account sees first.
 *
 * A user used to land on an empty Results table with nothing indicating that a
 * model and a LinkedIn session were required. Pasting a company URL and
 * pressing start was the natural next move, and it produced a run that could
 * not possibly work — twenty minutes of real LinkedIn calls, zero results, and
 * no error anywhere.
 *
 * So the requirements are stated before the work, with their current state
 * next to them.
 */

import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconArrowRight,
  IconBrandLinkedin,
  IconCheck,
  IconMail,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import type { PreflightCheck } from '../api/types';
import { useSetupStatus } from '../hooks/useSetupStatus';

interface GateProps {
  icon: typeof IconSparkles;
  title: string;
  blurb: string;
  settingsTab: string;
  check: PreflightCheck & { optional?: boolean };
}

function Gate({ icon: Icon, title, blurb, settingsTab, check }: GateProps) {
  const done = check.ok;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group align="flex-start" gap="md" wrap="nowrap">
          <ThemeIcon
            size={38}
            radius="md"
            variant="light"
            color={done ? 'teal' : check.optional ? 'gray' : 'orange'}
          >
            {done ? <IconCheck size={19} /> : <Icon size={19} />}
          </ThemeIcon>

          <Box>
            <Group gap="xs">
              <Text fw={600} fz={15}>
                {title}
              </Text>
              {check.optional && (
                <Badge size="xs" variant="light" color="gray">
                  optional
                </Badge>
              )}
            </Group>

            <Text fz={13.5} c="dimmed" mt={3}>
              {done ? (check.detail ?? blurb) : (check.message ?? blurb)}
            </Text>

            {!done && check.fix && (
              <Text fz={13} mt={6}>
                {check.fix}
              </Text>
            )}
          </Box>
        </Group>

        {!done && (
          <Button
            component={Link}
            to={`/settings?tab=${settingsTab}`}
            size="xs"
            variant="light"
            rightSection={<IconArrowRight size={14} />}
          >
            Set up
          </Button>
        )}
      </Group>
    </Card>
  );
}

export function SetupPage() {
  const { data, isPending } = useSetupStatus();
  const setup = data?.setup;

  return (
    <Stack gap="xl" maw={760}>
      <Box>
        <Title order={2}>Get set up</Title>
        <Text c="dimmed" fz={14} mt={4}>
          Two things are needed before a run can find anyone. This page updates
          itself as you go.
        </Text>
      </Box>

      {isPending || !setup ? (
        <Stack gap="md">
          <Skeleton height={96} radius="md" />
          <Skeleton height={96} radius="md" />
          <Skeleton height={96} radius="md" />
        </Stack>
      ) : (
        <>
          <Stack gap="md">
            <Gate
              icon={IconSparkles}
              title="An AI model to judge profiles"
              blurb="The built-in model needs no setup."
              settingsTab="ai"
              check={setup.aiModel}
            />
            <Gate
              icon={IconBrandLinkedin}
              title="A LinkedIn session"
              blurb="Supplied by the Chrome extension."
              settingsTab="linkedin"
              check={setup.linkedinSession}
            />
            <Gate
              icon={IconMail}
              title="An email account to send from"
              blurb="Only needed to send campaigns."
              settingsTab="outreach"
              check={setup.outreachEmail}
            />
          </Stack>

          {setup.readyToRun ? (
            <Alert
              color="teal"
              variant="light"
              radius="lg"
              icon={<IconCheck size={18} />}
              title="Ready to go"
            >
              <Stack align="flex-start" gap="sm">
                <Text fz={13.5}>
                  Everything a run needs is in place. Start one from Runs.
                </Text>
                <Button
                  component={Link}
                  to="/runs"
                  size="xs"
                  rightSection={<IconArrowRight size={14} />}
                >
                  Go to Runs
                </Button>
              </Stack>
            </Alert>
          ) : (
            <Alert
              color="gray"
              variant="light"
              radius="lg"
              icon={<IconX size={18} />}
            >
              <Text fz={13.5}>
                Runs are blocked until the two required items above are done.
                Starting one now would make hundreds of LinkedIn requests and
                return nothing, so the server refuses instead.
              </Text>
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
}
