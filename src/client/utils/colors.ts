/**
 * Tandem theme color utilities and constants.
 * Centralizes semantic color references — all values resolve through CSS custom properties
 * so light/dark mode switching is automatic.
 */

/**
 * Error state colors. Reference the CSS tokens defined in index.html.
 */
export const errorStateColors = {
  background: "var(--tandem-error-bg)",
  border: "var(--tandem-error-border)",
  color: "var(--tandem-error-fg-strong)",
} as const;

/**
 * Success state colors.
 */
export const successStateColors = {
  background: "var(--tandem-success-bg)",
  border: "var(--tandem-success-border)",
  color: "var(--tandem-success-fg-strong)",
} as const;

/**
 * Warning state colors (held-annotation banners, held badges, amber UI surfaces).
 */
export const warningStateColors = {
  background: "var(--tandem-warning-bg)",
  border: "var(--tandem-warning-border)",
  color: "var(--tandem-warning-fg-strong)",
} as const;
