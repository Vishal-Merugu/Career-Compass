/**
 * Everything that used to be configured in the extension, plus what was
 * already here.
 *
 * Tabs rather than one long scroll: these are four unrelated concerns visited
 * for different reasons, and the AI model — the one that decides whether a run
 * can work at all — should not be buried below a résumé upload.
 *
 * The extension no longer writes any of this. It reads what it still needs
 * (the daily limit, the email-finder toggle) and is otherwise a supplier of
 * browser-bound capabilities. One writer, one place.
 */

import { Box, Stack, Tabs, Text, Title } from '@mantine/core';
import {
  IconBrandLinkedin,
  IconBrandTelegram,
  IconMail,
  IconRadar,
  IconSparkles,
} from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { AiModelSection } from './settings/AiModelSection';
import { FinderSection } from './settings/FinderSection';
import { LinkedInSection } from './settings/LinkedInSection';
import { OutreachSection } from './settings/OutreachSection';
import { TelegramSection } from './settings/TelegramSection';

const TABS = [
  { value: 'ai', label: 'AI model', icon: IconSparkles },
  { value: 'linkedin', label: 'LinkedIn', icon: IconBrandLinkedin },
  { value: 'finder', label: 'Finder', icon: IconRadar },
  { value: 'outreach', label: 'Outreach email', icon: IconMail },
  { value: 'telegram', label: 'Telegram', icon: IconBrandTelegram },
];

export function SettingsPage() {
  // In the URL so the readiness banner and the setup checklist can link
  // straight at the thing that needs fixing.
  const [params, setParams] = useSearchParams();
  const active = params.get('tab') ?? 'ai';

  return (
    <Stack gap="xl" maw={760}>
      <Box>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" fz={14} mt={4}>
          Everything a run needs, in one place.
        </Text>
      </Box>

      <Tabs
        value={active}
        onChange={(value) => setParams(value ? { tab: value } : {})}
        keepMounted={false}
      >
        <Tabs.List mb="xl">
          {TABS.map(({ value, label, icon: Icon }) => (
            <Tabs.Tab
              key={value}
              value={value}
              leftSection={<Icon size={15} />}
            >
              {label}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel value="ai">
          <AiModelSection />
        </Tabs.Panel>
        <Tabs.Panel value="linkedin">
          <LinkedInSection />
        </Tabs.Panel>
        <Tabs.Panel value="finder">
          <FinderSection />
        </Tabs.Panel>
        <Tabs.Panel value="outreach">
          <OutreachSection />
        </Tabs.Panel>
        <Tabs.Panel value="telegram">
          <TelegramSection />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
