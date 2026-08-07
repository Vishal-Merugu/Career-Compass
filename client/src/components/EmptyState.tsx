import { Box, Stack, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  /** Defaults to an inbox. Pass one that matches what is missing. */
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * The "nothing here yet" block inside a panel. Results, Campaigns and Campaign
 * detail each had their own copy at slightly different paddings and widths;
 * three empty states that differ by 8px read as three different components.
 *
 * The glyph is heavily dimmed on purpose — it is a label for the absence, not
 * an illustration, and the sentence below it is what the reader needs.
 */
export function EmptyState({ title, icon, children }: EmptyStateProps) {
  return (
    <Stack align="center" py={60} px="md" gap={6}>
      <Box c="dimmed" style={{ opacity: 0.4, display: 'flex' }}>
        {icon ?? <IconInbox size={34} stroke={1.4} />}
      </Box>
      <Text fw={600} fz={15} mt={6}>
        {title}
      </Text>
      <Text c="dimmed" fz={13.5} ta="center" maw={400}>
        {children}
      </Text>
    </Stack>
  );
}
