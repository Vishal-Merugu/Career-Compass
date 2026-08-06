import { Box, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { CompassMark, Wordmark } from './Logo';
import classes from './AuthShell.module.css';

const POINTS = [
  'Discover roles and decision-makers across your target companies',
  'Qualify every profile against your context before you reach out',
  'Track outreach, limits and daily activity in one place',
];

interface AuthShellProps {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  /** Small print under the form — differs between signing in and signing up. */
  footnote?: ReactNode;
}

/**
 * The split-screen frame shared by the sign-in and sign-up screens. Extracted
 * so the two cannot drift apart; the brand panel is identical on both and only
 * the form column changes.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footnote,
}: AuthShellProps) {
  return (
    <div className={classes.root}>
      <aside className={classes.brand}>
        <div className={classes.brandContent}>
          <Wordmark size={30} />
        </div>

        <div className={classes.brandContent}>
          <Title
            order={1}
            fz={38}
            fw={620}
            c="#f4f4f5"
            style={{ letterSpacing: '-0.028em', lineHeight: 1.15 }}
          >
            Every conversation
            <br />
            starts with the right
            <br />
            person.
          </Title>

          <ul className={classes.pointList} style={{ marginTop: 28 }}>
            {POINTS.map((point) => (
              <li key={point} className={classes.point}>
                <span className={classes.pointDot} />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <Text
          className={classes.brandContent}
          fz={12.5}
          c="rgba(244,244,245,0.42)"
        >
          Reachable on the university network only.
        </Text>
      </aside>

      <main className={classes.form}>
        <div className={classes.formInner}>
          <Stack gap={0} mb="xl">
            {/* The mark repeats here for the narrow layout, where the brand
                panel is hidden entirely. */}
            <Box hiddenFrom="lg" mb="lg">
              <Wordmark size={28} />
            </Box>
            <Title order={2} fz={26}>
              {title}
            </Title>
            <Text c="dimmed" size="sm" mt={6}>
              {subtitle}
            </Text>
          </Stack>

          {children}

          {footnote}

          <Box hiddenFrom="lg" mt="xl" ta="center" c="dimmed">
            <Group justify="center" gap={7}>
              <CompassMark size={14} />
              <Text fz={12}>University network only</Text>
            </Group>
          </Box>
        </div>
      </main>
    </div>
  );
}
