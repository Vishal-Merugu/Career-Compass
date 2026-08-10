import {
  ActionIcon,
  AppShell,
  Avatar,
  Box,
  Burger,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconChecklist,
  IconChevronDown,
  IconLogout,
  IconMail,
  IconMoon,
  IconRadar,
  IconSun,
  IconSettings,
  IconTable,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Wordmark } from './Logo';
import { ReadinessBanner } from './ReadinessBanner';
import classes from './DashboardLayout.module.css';

const NAV_SECTIONS = [
  {
    label: 'Pipeline',
    items: [
      // Runs first: it is the live screen, and Results is what a run produces.
      { to: '/runs', label: 'Runs', icon: IconRadar },
      { to: '/results', label: 'Results', icon: IconTable },
    ],
  },
  {
    label: 'Outreach',
    items: [{ to: '/campaigns', label: 'Campaigns', icon: IconMail }],
  },
  {
    label: 'Setup',
    items: [
      { to: '/setup', label: 'Get set up', icon: IconChecklist },
      { to: '/settings', label: 'Settings', icon: IconSettings },
    ],
  },
];

function initials(email: string): string {
  const name = email.split('@')[0] ?? '';
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`
      : name.slice(0, 2) || '?';
  return letters.toUpperCase();
}

function ColorSchemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <Tooltip label={isDark ? 'Light mode' : 'Dark mode'}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        radius="md"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setColorScheme(isDark ? 'light' : 'dark')}
      >
        {isDark ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

export function DashboardLayout() {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <AppShell
      header={{ height: 58 }}
      navbar={{ width: 236, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header className={classes.header} withBorder={false}>
        <Group h="100%" px="lg" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Wordmark size={24} />
          </Group>

          <Group gap={6} wrap="nowrap">
            <ColorSchemeToggle />

            <Menu position="bottom-end" withArrow shadow="md" width={220}>
              <Menu.Target>
                <UnstyledButton className={classes.userButton}>
                  <Avatar size={28} radius="xl" color="brand" variant="light">
                    <Text fz={11} fw={650}>
                      {initials(user?.email ?? '')}
                    </Text>
                  </Avatar>
                  <Text fz={13.5} fw={500} visibleFrom="sm" maw={180} truncate>
                    {user?.email}
                  </Text>
                  <IconChevronDown size={14} opacity={0.5} />
                </UnstyledButton>
              </Menu.Target>

              <Menu.Dropdown>
                <Menu.Label>Signed in as</Menu.Label>
                <Box px="sm" pb={8}>
                  <Text fz={13} fw={500} truncate>
                    {user?.email}
                  </Text>
                </Box>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={15} />}
                  onClick={() => void handleLogout()}
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar
        className={classes.navbar}
        px="md"
        py="sm"
        withBorder={false}
      >
        <Stack gap={26} style={{ height: '100%' }}>
          {NAV_SECTIONS.map((section) => (
            <Stack key={section.label} gap={3}>
              <Text className={classes.sectionLabel} mb={8}>
                {section.label}
              </Text>
              {section.items.map(({ to, label, icon: Icon }) => (
                <UnstyledButton
                  key={to}
                  component={Link}
                  to={to}
                  className={classes.navLink}
                  data-active={
                    location.pathname === to ||
                    location.pathname.startsWith(`${to}/`) ||
                    undefined
                  }
                  onClick={close}
                >
                  <Group gap={10} wrap="nowrap">
                    <Icon size={17} stroke={1.7} />
                    {label}
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          ))}

          <Box style={{ marginTop: 'auto' }} px={10} pb={4}>
            <Group gap={8} wrap="nowrap">
              <span className={classes.statusDot} />
              <Text fz={11.5} c="dimmed">
                Connected
              </Text>
            </Group>
          </Box>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>
        <Box p={{ base: 'md', sm: 'xl' }} maw={1400} mx="auto">
          <ReadinessBanner />
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
