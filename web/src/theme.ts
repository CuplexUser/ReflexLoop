import { theme, type ThemeConfig } from 'antd'

export type ThemeMode = 'dark' | 'light'

// "Operator console" palette: a layered neutral base (not flat black in dark, not flat white
// in light) with one warm accent reserved for "needs your decision", plus a semantic set for
// the outcomes that follow it. Amber was picked over the more common acid-green/vermilion
// dark-mode accent specifically because this screen's single most important moment is a
// caution/attention state, not a brand flourish.
//
// Two representations of the same palette, and they have to stay in step:
//   - HEX_PALETTES below, which Ant Design needs as real colors (it derives hover/active
//     shades from them with color math, which a `var()` string would break);
//   - the `--rl-*` custom properties in index.css, which is what `palette` resolves to.
// Components import `palette` and get variables, so they follow the theme without knowing it.
export const HEX_PALETTES: Record<ThemeMode, Record<string, string>> = {
  dark: {
    bgBase: '#12151B',
    bgRaised: '#1B1F27',
    bgSunken: '#0D0F14',
    border: '#262B35',
    borderStrong: '#333A47',
    textPrimary: '#E7EAF0',
    textMuted: '#8A93A6',
    textFaint: '#5B6272',
    pending: '#E8A33D',
    approved: '#3FB68B',
    rejected: '#E5654F',
    active: '#6C8CFF',
  },
  light: {
    bgBase: '#F4F6FA',
    bgRaised: '#FFFFFF',
    bgSunken: '#E8ECF3',
    border: '#DCE1EA',
    borderStrong: '#C3CAD6',
    textPrimary: '#1A1F2A',
    textMuted: '#5B6272',
    textFaint: '#8A93A6',
    // Darkened from the dark-theme values so they still carry contrast on a light ground.
    pending: '#B77714',
    approved: '#1F8F68',
    rejected: '#C4402A',
    active: '#3E63DD',
  },
}

/**
 * What components import. Every value is a CSS variable, so a theme switch repaints without
 * re-rendering anything — index.css defines both sets and the `data-theme` attribute picks one.
 */
export const palette = {
  bgBase: 'var(--rl-bg-base)',
  bgRaised: 'var(--rl-bg-raised)',
  bgSunken: 'var(--rl-bg-sunken)',
  border: 'var(--rl-border)',
  borderStrong: 'var(--rl-border-strong)',
  textPrimary: 'var(--rl-text-primary)',
  textMuted: 'var(--rl-text-muted)',
  textFaint: 'var(--rl-text-faint)',
  pending: 'var(--rl-pending)',
  approved: 'var(--rl-approved)',
  rejected: 'var(--rl-rejected)',
  active: 'var(--rl-active)',
} as const

const fontSans = '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const fontMono = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export function buildAntdTheme(mode: ThemeMode): ThemeConfig {
  const p = HEX_PALETTES[mode]
  return {
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorBgBase: p.bgBase,
      colorBgContainer: p.bgRaised,
      colorBgElevated: p.bgRaised,
      colorBgLayout: p.bgBase,
      colorBorder: p.border,
      colorBorderSecondary: p.border,
      colorText: p.textPrimary,
      colorTextSecondary: p.textMuted,
      colorTextTertiary: p.textFaint,
      colorPrimary: p.pending,
      colorSuccess: p.approved,
      colorError: p.rejected,
      colorInfo: p.active,
      colorLink: p.active,
      fontFamily: fontSans,
      fontFamilyCode: fontMono,
      borderRadius: 8,
      wireframe: false,
    },
    components: {
      Layout: {
        siderBg: p.bgSunken,
        headerBg: p.bgSunken,
        bodyBg: p.bgBase,
      },
      Menu: {
        darkItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
      },
      Statistic: {
        fontFamily: fontMono,
      },
    },
  }
}
