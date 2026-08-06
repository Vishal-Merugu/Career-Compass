import { createTheme, rem } from '@mantine/core';
import type { CSSVariablesResolver, MantineColorsTuple } from '@mantine/core';

/**
 * Design tokens.
 *
 * The look is neutral-dominant on purpose: one restrained accent, hairline
 * borders instead of shadows, and a warm off-white rather than pure #fff. Colour
 * is reserved for things that mean something — the primary action, and status.
 * Nothing decorative gets a hue.
 */

/** Deep indigo. Used for the primary action, focus, and the active nav item. */
const brand: MantineColorsTuple = [
  '#eef0fb',
  '#dcdff3',
  '#b6bce6',
  '#8e97d9',
  '#6d78ce',
  '#5866c8',
  '#4b5bc6',
  '#3c4aae',
  '#34419c',
  '#2a378a',
];

/**
 * Neutrals, warm rather than blue-grey. Mantine's `dark` tuple runs
 * light → dark, and drives every surface in dark mode.
 */
const ink: MantineColorsTuple = [
  '#f7f7f8',
  '#ededef',
  '#d3d3d7',
  '#b7b7bd',
  '#9fa0a7',
  '#8f9098',
  '#87888f',
  '#74757c',
  '#67686f',
  '#595a62',
];

const shell: MantineColorsTuple = [
  '#c9c9ce',
  '#a6a7ad',
  '#8f9096',
  '#6d6e75',
  '#4a4b52',
  '#33343a',
  '#26262b',
  '#1b1b1f',
  '#141417',
  '#0c0c0e',
];

export const theme = createTheme({
  primaryColor: 'brand',
  // A slightly deeper step in light mode reads as considered; a lighter one in
  // dark mode keeps it from vibrating against a near-black surface.
  primaryShade: { light: 7, dark: 4 },
  colors: { brand, gray: ink, dark: shell },

  fontFamily:
    '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace:
    'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',

  headings: {
    fontWeight: '600',
    sizes: {
      // Negative tracking on large text is most of what separates a considered
      // typographic setting from a default one.
      h1: { fontSize: rem(30), lineHeight: '1.2', fontWeight: '650' },
      h2: { fontSize: rem(24), lineHeight: '1.25', fontWeight: '650' },
      h3: { fontSize: rem(19), lineHeight: '1.3', fontWeight: '600' },
      h4: { fontSize: rem(16), lineHeight: '1.4', fontWeight: '600' },
    },
  },

  defaultRadius: 'md',
  radius: { xs: rem(4), sm: rem(6), md: rem(8), lg: rem(12), xl: rem(16) },

  // Depth comes from hairlines, not drop shadows. These stay deliberately faint
  // and are used only where something genuinely floats.
  shadows: {
    xs: '0 1px 2px rgba(16, 17, 20, 0.04)',
    sm: '0 1px 3px rgba(16, 17, 20, 0.06), 0 1px 2px rgba(16, 17, 20, 0.04)',
    md: '0 4px 12px rgba(16, 17, 20, 0.07), 0 1px 3px rgba(16, 17, 20, 0.05)',
    lg: '0 12px 32px rgba(16, 17, 20, 0.10), 0 2px 6px rgba(16, 17, 20, 0.05)',
  },

  components: {
    Button: {
      defaultProps: { radius: 'md' },
      styles: { root: { fontWeight: 550, letterSpacing: '-0.005em' } },
    },
    Paper: { defaultProps: { radius: 'lg' } },
    Card: { defaultProps: { radius: 'lg' } },
    TextInput: { defaultProps: { radius: 'md' } },
    PasswordInput: { defaultProps: { radius: 'md' } },
    Badge: {
      defaultProps: { radius: 'sm', variant: 'light' },
      styles: {
        root: {
          fontWeight: 550,
          letterSpacing: '0.01em',
          textTransform: 'none',
        },
      },
    },
    Tooltip: {
      defaultProps: { radius: 'sm', withArrow: true, openDelay: 300 },
    },
  },
});

/**
 * Surfaces and hairlines, exposed as CSS variables so plain CSS and inline
 * styles read from the same source as the components do.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--app-bg': '#fbfbfa',
    '--app-surface': '#ffffff',
    '--app-surface-sunken': '#f4f4f3',
    // Hairlines carry all the structure here, since almost nothing has a
    // shadow. Too faint and panels dissolve into the page.
    '--app-border': 'rgba(16, 17, 20, 0.11)',
    '--app-border-strong': 'rgba(16, 17, 20, 0.17)',
    '--app-ink': '#18181b',
    '--app-ink-muted': '#5c5d66',
    // Hover fills are their own token rather than reusing the border colour.
    // A border tint is calibrated for a 1px line, not for a filled area.
    '--app-hover': 'rgba(16, 17, 20, 0.05)',
    // The accent at a strength that survives on a surface, for the few marks
    // that carry meaning rather than decoration — currently the active nav
    // item's icon. brand-7 in light, brand-4 in dark: the mid tuple steps are
    // too weak on white and too strong on near-black respectively.
    '--app-accent': '#3c4aae',
    '--app-overlay': 'rgba(251, 251, 250, 0.72)',
    // Mantine resolves `c="dimmed"` to gray-6 / dark-2, which is tuned for
    // captions. Most secondary text in this app is 13px body copy, and at that
    // size the default reads washed out rather than quiet.
    '--mantine-color-dimmed': '#5c5d66',
  },
  dark: {
    '--app-bg': '#0b0b0d',
    // Lifted off the background so panels and the navbar separate without
    // needing a heavier border.
    '--app-surface': '#17171b',
    '--app-surface-sunken': '#101013',
    '--app-border': 'rgba(255, 255, 255, 0.12)',
    '--app-border-strong': 'rgba(255, 255, 255, 0.19)',
    '--app-ink': '#f0f0f2',
    '--app-ink-muted': '#a4a5ae',
    '--app-hover': 'rgba(255, 255, 255, 0.06)',
    '--app-accent': '#6d78ce',
    '--app-overlay': 'rgba(11, 11, 13, 0.72)',
    '--mantine-color-dimmed': '#a4a5ae',
  },
});
