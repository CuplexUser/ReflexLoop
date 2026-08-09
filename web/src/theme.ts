import { theme, type ThemeConfig } from 'antd'

// "Operator console" palette: a layered dark neutral base (not flat black)
// with one warm accent reserved for "needs your decision", plus a semantic
// set for the outcomes that follow it. Amber was picked over the more
// common acid-green/vermilion dark-mode accent specifically because this
// screen's single most important moment is a caution/attention state, not
// a brand flourish.
export const palette = {
  bgBase: '#12151B',
  bgRaised: '#1B1F27',
  bgSunken: '#0D0F14',
  border: '#262B35',
  borderStrong: '#333A47',
  textPrimary: '#E7EAF0',
  textMuted: '#8A93A6',
  textFaint: '#5B6272',
  pending: '#E8A33D', // needs a human decision
  approved: '#3FB68B', // approved / success
  rejected: '#E5654F', // rejected / failed
  active: '#6C8CFF', // in progress
} as const

const fontSans =
  '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const fontMono =
  '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export const antdTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorBgBase: palette.bgBase,
    colorBgContainer: palette.bgRaised,
    colorBgElevated: palette.bgRaised,
    colorBgLayout: palette.bgBase,
    colorBorder: palette.border,
    colorBorderSecondary: palette.border,
    colorText: palette.textPrimary,
    colorTextSecondary: palette.textMuted,
    colorTextTertiary: palette.textFaint,
    colorPrimary: palette.pending,
    colorSuccess: palette.approved,
    colorError: palette.rejected,
    colorInfo: palette.active,
    colorLink: palette.active,
    fontFamily: fontSans,
    fontFamilyCode: fontMono,
    borderRadius: 8,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: palette.bgSunken,
      headerBg: palette.bgSunken,
      bodyBg: palette.bgBase,
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
