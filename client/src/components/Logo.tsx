import { Box, Text } from '@mantine/core';

/**
 * Wordmark. The compass rose is drawn rather than imported so it inherits
 * `currentColor` and needs no asset request — the VM serves this over a VPN
 * with no CDN reachable.
 */
export function CompassMark({ size = 26 }: { size?: number }) {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      w={size}
      h={size}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.35"
      />
      {/* The needle: filled north half, hollow south — reads as a compass at
          16px, where a more detailed rose turns to mush. */}
      <path d="M12 5.2 L14.6 12 L12 12 Z" fill="currentColor" />
      <path d="M12 5.2 L9.4 12 L12 12 Z" fill="currentColor" opacity="0.55" />
      <path d="M12 18.8 L9.4 12 L12 12 Z" fill="currentColor" opacity="0.3" />
      <path d="M12 18.8 L14.6 12 L12 12 Z" fill="currentColor" opacity="0.15" />
    </Box>
  );
}

export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <Box c="brand.6" style={{ display: 'flex' }}>
        <CompassMark size={size} />
      </Box>
      <Text
        fw={620}
        fz={size * 0.62}
        style={{ letterSpacing: '-0.022em', whiteSpace: 'nowrap' }}
      >
        CareerCompass
      </Text>
    </Box>
  );
}
