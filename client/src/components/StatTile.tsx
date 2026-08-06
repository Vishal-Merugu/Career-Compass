import { Box, Group, Paper, Skeleton, Text } from '@mantine/core';
import type { ReactNode } from 'react';

interface StatTileProps {
  label: string;
  value: number;
  /** Optional qualifier under the value, e.g. "62% of all profiles". */
  hint?: string;
  icon?: ReactNode;
  loading?: boolean;
}

/** 1,284 / 12.9K / 1.2M — long numbers must not reflow the tile. */
function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * A headline number. Deliberately monochrome — these are co-equal facts, not
 * categories, so giving each one a hue would invent a distinction that isn't in
 * the data. Colour stays reserved for the primary action and for status.
 *
 * The value uses the font's default proportional figures, not `tabular-nums`:
 * tabular gives every digit the width of a zero, which reads loose at display
 * sizes. Tabular figures belong in the table columns, where they align.
 */
export function StatTile({ label, value, hint, icon, loading }: StatTileProps) {
  return (
    <Paper
      p="lg"
      radius="lg"
      style={{
        backgroundColor: 'var(--app-surface)',
        border: '1px solid var(--app-border)',
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text
          fz={12.5}
          fw={550}
          c="dimmed"
          style={{ letterSpacing: '0.005em' }}
        >
          {label}
        </Text>
        {icon && (
          <Box c="dimmed" style={{ opacity: 0.55, display: 'flex' }}>
            {icon}
          </Box>
        )}
      </Group>

      {loading ? (
        <Skeleton height={30} width={72} radius="sm" mt={12} />
      ) : (
        <Text
          fz={30}
          fw={620}
          mt={8}
          lh={1.15}
          style={{ letterSpacing: '-0.025em' }}
        >
          {compact(value)}
        </Text>
      )}

      {hint && (
        <Text fz={12} c="dimmed" mt={4}>
          {loading ? ' ' : hint}
        </Text>
      )}
    </Paper>
  );
}
