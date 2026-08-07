import { createTheme, rem } from '@mantine/core';
import type { CSSVariablesResolver, MantineColorsTuple } from '@mantine/core';

/**
 * Design tokens.
 *
 * The palette is **amber / copper on warm stone**, from Figma's colour-scheme
 * library. It reads editorial rather than SaaS-template: almost every dashboard
 * reaches for blue, and blue is what the previous scheme did before this one.
 *
 * It replaces a neutral-grey-and-white scheme that was correct in principle and
 * lifeless in practice. The fix is not more colour on more things — it is that
 * **nothing here is a pure grey**. Every neutral carries a warm stone cast,
 * every shadow is tinted with brown rather than black, and the accent is used
 * where it means something: the primary action, the current page, focus, and
 * the marks on a stat tile.
 *
 * The one cool note (`--app-cool`) is deliberate. An all-warm interface goes
 * syrupy; a single muted teal at low strength stops that without introducing a
 * second accent that competes for meaning.
 *
 * **This palette costs something, and the cost is paid in `StatusBadge.tsx`.**
 * Amber is close enough to the orange that used to mean "stopped" and "some
 * failed" that the two were indistinguishable, so the status hues moved: see
 * that file. Nothing in the app may use amber or orange to mean a state.
 */

/**
 * Copper → amber. Primary action, focus, active nav, stat-tile marks.
 *
 * Deep enough at the light end to carry white text (5.74:1 on brand-8), bright
 * enough at the dark end to read on a near-black surface (7.16:1 on brand-4).
 */
const brand: MantineColorsTuple = [
  '#fdf5ea',
  '#f9e8d3',
  '#f2cda2',
  '#ebae6d',
  '#e3933f',
  '#dd8425',
  '#d0781c',
  '#b56513',
  '#9c530c',
  '#7d4109',
];

/**
 * Neutrals with a warm stone cast. Mantine's `gray` tuple runs light → dark and
 * drives body copy, dimmed text and default borders.
 *
 * The warmth is what lets the copper sit on them without looking bolted on: an
 * accent only reads as part of a palette when the neutrals share its
 * temperature. A cool grey under a copper button makes the button look like a
 * sticker.
 */
const ink: MantineColorsTuple = [
  '#faf8f5',
  '#f1ece5',
  '#e0d8cd',
  '#cabfb1',
  '#b1a696',
  '#9a8f80',
  '#877c6d',
  '#6f6459',
  '#5c534a',
  '#4a423a',
];

/**
 * Dark-mode surfaces, light → dark. Warm near-black rather than neutral black.
 *
 * This is what makes the scheme work in dark mode rather than merely survive
 * it: amber on a cold grey-black looks like a warning light, amber on a warm
 * espresso-black looks like a lamp. Index 2 doubles as dark mode's dimmed text.
 */
const shell: MantineColorsTuple = [
  '#d5cec5',
  '#c2b8ab',
  '#b0a496',
  '#786e62',
  '#564e44',
  '#3d372f',
  '#2a251f',
  '#1c1813',
  '#15120e',
  '#100d09',
];

export const theme = createTheme({
  primaryColor: 'brand',
  // A deep step in light mode reads as considered; a lighter one in dark mode
  // keeps it from vibrating against a near-black surface.
  primaryShade: { light: 8, dark: 4 },
  colors: { brand, gray: ink, dark: shell },

  // Required by the shade choice above, not a preference. Dark mode's primary
  // is brand-4 (#e3933f) and Mantine puts white on a filled button by default,
  // which measures 2.47:1 — unreadable. With autoContrast the label flips to
  // dark on that button (7.24:1) and stays white on light mode's brand-8
  // (5.74:1). An amber palette needs this in a way a blue one does not: amber
  // is bright at every shade a filled control would want to use.
  autoContrast: true,

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

  // Tinted brown, never black. This is the cheapest and most reliable
  // "premium" tell there is: a neutral-grey shadow on a warm surface reads as
  // dirt, a shadow sharing the surface's hue reads as light falling on a
  // material.
  //
  // Two layers each: a tight contact shadow for the edge and a wider ambient
  // one for the lift. A single blurred shadow is what makes an interface look
  // like a wireframe with a filter over it.
  //
  // Dark mode does NOT reuse these — see --app-shadow-* in the resolver below.
  shadows: {
    xs: '0 1px 2px rgba(61, 42, 22, 0.07)',
    sm: '0 1px 2px rgba(61, 42, 22, 0.08), 0 2px 6px rgba(61, 42, 22, 0.06)',
    md: '0 2px 4px rgba(61, 42, 22, 0.07), 0 6px 16px rgba(61, 42, 22, 0.10)',
    lg: '0 4px 8px rgba(61, 42, 22, 0.08), 0 16px 40px rgba(61, 42, 22, 0.14)',
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
 * Surfaces, hairlines and shadows, exposed as CSS variables so plain CSS and
 * inline styles read from the same source as the components do.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    // Not #fff and not a grey: a warm stone off-white. The page and the panels
    // have to differ by a hue as well as a value, or the panels read as
    // slightly dirty paper instead of as raised surfaces.
    '--app-bg': '#faf7f2',
    '--app-surface': '#ffffff',
    '--app-surface-sunken': '#f2ece3',
    // Hairlines carry most of the structure. Tinted to match, so an edge never
    // looks like a grey line drawn over a warm page.
    '--app-border': 'rgba(74, 58, 38, 0.14)',
    '--app-border-strong': 'rgba(74, 58, 38, 0.22)',
    // Warm near-black rather than #000-family. Cold text on a warm background
    // is the other half of why the old scheme read as grey-on-white.
    '--app-ink': '#2a2119',
    '--app-ink-muted': '#5c534a',
    // Hover fills are their own token rather than reusing the border colour: a
    // border tint is calibrated for a 1px line, not for a filled area.
    '--app-hover': 'rgba(74, 58, 38, 0.055)',
    // The accent, and a wash of it for tinted fills — the active nav item, a
    // selected row, the mark on a stat tile. 5.74:1 against white.
    '--app-accent': '#9c530c',
    '--app-accent-wash': 'rgba(156, 83, 12, 0.09)',
    '--app-accent-line': 'rgba(156, 83, 12, 0.30)',
    // The counter-note. Muted teal, used only in the page wash — see the file
    // header. It is NOT a second accent and nothing interactive may use it.
    '--app-cool': '#3f6b73',
    '--app-shadow-sm':
      '0 1px 2px rgba(61, 42, 22, 0.08), 0 2px 6px rgba(61, 42, 22, 0.06)',
    '--app-shadow-md':
      '0 2px 4px rgba(61, 42, 22, 0.07), 0 6px 16px rgba(61, 42, 22, 0.10)',
    '--app-overlay': 'rgba(250, 247, 242, 0.72)',
    // A gradient rather than a flat fill, at a strength you would not notice
    // directly — it stops a full-height page from reading as one dead slab.
    '--app-bg-gradient':
      'radial-gradient(1200px 600px at 15% -10%, color-mix(in srgb, var(--app-accent) 8%, transparent), transparent 60%), radial-gradient(900px 500px at 100% 0%, color-mix(in srgb, var(--app-cool) 6%, transparent), transparent 55%)',
    '--app-accent-gradient':
      'linear-gradient(180deg, #b56513 0%, #9c530c 100%)',
    // Mantine resolves `c="dimmed"` to gray-6 / dark-2, which is tuned for
    // captions. Most secondary text here is 13px body copy, and at that size
    // the default reads washed out rather than quiet. 7.52:1 on the surface,
    // 6.41:1 on the sunken one — measured, not eyeballed.
    '--mantine-color-dimmed': '#5c534a',
  },
  dark: {
    // Espresso-black, not neutral black. This is the whole reason the scheme
    // survives dark mode: amber on a cold grey-black reads as a warning light,
    // amber on a warm black reads as a lamp.
    '--app-bg': '#100d09',
    // Lifted off the background so panels and the navbar separate without
    // needing a heavier border.
    '--app-surface': '#1c1813',
    '--app-surface-sunken': '#15120e',
    '--app-border': 'rgba(232, 214, 190, 0.14)',
    '--app-border-strong': 'rgba(232, 214, 190, 0.23)',
    '--app-ink': '#f2ede6',
    '--app-ink-muted': '#b0a496',
    '--app-hover': 'rgba(232, 214, 190, 0.07)',
    // 7.16:1 on the surface. Lighter than light mode's copper, which would
    // disappear entirely against #1c1813.
    '--app-accent': '#e3933f',
    '--app-accent-wash': 'rgba(227, 147, 63, 0.12)',
    '--app-accent-line': 'rgba(227, 147, 63, 0.32)',
    '--app-cool': '#6ea3ab',
    // Darker AND more opaque than light mode. A shadow works by darkening what
    // is behind it, and there is very little headroom left below #100d09 — so
    // dark mode leans on the inset highlight along the top edge instead, which
    // is what actually reads as "raised" against a near-black background.
    '--app-shadow-sm':
      '0 1px 2px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(232, 214, 190, 0.06)',
    '--app-shadow-md':
      '0 2px 6px rgba(0, 0, 0, 0.5), 0 8px 24px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(232, 214, 190, 0.07)',
    '--app-overlay': 'rgba(16, 13, 9, 0.72)',
    '--app-bg-gradient':
      'radial-gradient(1200px 600px at 15% -10%, color-mix(in srgb, var(--app-accent) 10%, transparent), transparent 60%), radial-gradient(900px 500px at 100% 0%, color-mix(in srgb, var(--app-cool) 7%, transparent), transparent 55%)',
    '--app-accent-gradient':
      'linear-gradient(180deg, #ebae6d 0%, #e3933f 100%)',
    '--mantine-color-dimmed': '#b0a496',
  },
});
