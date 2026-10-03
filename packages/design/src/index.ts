/**
 * @otis/design
 *
 * Semantic design tokens from design.md. Values live in `tokens.css` as CSS
 * custom properties; this module exposes the same names for TypeScript call
 * sites (inline layout styles, tests) so there is one palette, not two.
 */

export const TOKENS = {
  /** Semantic CSS custom properties. Use these, never a hex literal. */
  color: {
    canvas: 'var(--otis-canvas)',
    sidebar: 'var(--otis-sidebar)',
    surface: 'var(--otis-surface)',
    surfaceHover: 'var(--otis-surface-hover)',
    surfaceRaised: 'var(--otis-surface-raised)',
    border: 'var(--otis-border)',
    textPrimary: 'var(--otis-text-primary)',
    textSecondary: 'var(--otis-text-secondary)',
    textMuted: 'var(--otis-text-muted)',
    actionBg: 'var(--otis-action-bg)',
    actionFg: 'var(--otis-action-fg)',
    focusRing: 'var(--otis-focus-ring)',
    danger: 'var(--otis-danger)',
    warning: 'var(--otis-warning)',
    success: 'var(--otis-success)',
  },
  space: {
    1: 'var(--otis-space-1)',
    2: 'var(--otis-space-2)',
    3: 'var(--otis-space-3)',
    4: 'var(--otis-space-4)',
    6: 'var(--otis-space-6)',
    8: 'var(--otis-space-8)',
    12: 'var(--otis-space-12)',
  },
  radius: {
    control: 'var(--otis-radius-control)',
    menu: 'var(--otis-radius-menu)',
    turn: 'var(--otis-radius-turn)',
  },
  font: {
    sans: 'var(--otis-font-sans)',
    body: 'var(--otis-text-body)',
    leadingBody: 'var(--otis-leading-body)',
    ui: 'var(--otis-text-ui)',
    leadingUi: 'var(--otis-leading-ui)',
    meta: 'var(--otis-text-meta)',
    leadingMeta: 'var(--otis-leading-meta)',
    title: 'var(--otis-text-title)',
    leadingTitle: 'var(--otis-leading-title)',
    measure: 'var(--otis-measure)',
  },
  layout: {
    gutter: 'var(--otis-gutter)',
    topBar: 'var(--otis-topbar)',
    sidebarWidth: 'var(--otis-sidebar-width)',
    detailWidth: 'var(--otis-detail-width)',
    contentWidth: 'var(--otis-content-width)',
    hitTarget: 'var(--otis-hit)',
    duration: 'var(--otis-duration)',
  },
  /**
   * Breakpoints from design.md section 4. Initial rules: drawer below 900px,
   * persistent sidebar at 900px and above, side-by-side detail around 1280px.
   */
  breakpoints: {
    sidebar: 900,
    detail: 1280,
  },
} as const;

export type OtisColorToken = keyof typeof TOKENS.color;