/**
 * Tandem theme color utilities and constants.
 * Centralizes semantic color references — all values resolve through CSS custom properties
 * so light/dark mode switching is automatic.
 */

/**
 * Warning state colors (held-annotation banners, held badges, amber UI surfaces).
 */
export const warningStateColors = {
  background: "var(--tandem-warning-bg)",
  border: "var(--tandem-warning-border)",
  color: "var(--tandem-warning-fg-strong)",
} as const;
