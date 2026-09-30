/**
 * @otis/design
 * Design tokens, typography, and layout standards specified in design.md.
 */

export const TOKENS = {
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
  },
  touchTarget: {
    min: '44px',
  },
  typography: {
    title: '20px',
    body: '16px',
    secondary: '14px',
    caption: '13px',
    lineHeight: '1.5',
    measure: '65ch',
  },
  breakpoints: {
    mobile: '360px',
    desktopSidebar: '260px',
    desktopDetailPane: '360px',
  },
  colors: {
    dark: {
      bg: '#0f1115',
      surface: '#161920',
      surfaceRaised: '#1e222b',
      border: 'rgba(255, 255, 255, 0.08)',
      textPrimary: '#f0f3f6',
      textSecondary: '#9ba3af',
      accent: '#3b82f6',
      danger: '#ef4444',
      warning: '#f59e0b',
      success: '#10b981',
    },
  },
} as const;
