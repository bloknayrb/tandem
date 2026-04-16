/**
 * Tandem theme color utilities and constants.
 * Centralizes semantic color references — all values resolve through CSS custom properties
 * so light/dark mode switching is automatic.
 */

/**
 * Error state colors. Reference the CSS tokens defined in index.html rather than
 * recomputing the same color-mix formula in JavaScript.
 */
export const errorStateColors = {
  background: "var(--tandem-error-bg)",
  border: "var(--tandem-error-border)",
} as const;

/**
 * Warning state colors (held-annotation banners, held badges, amber UI surfaces).
 */
export const warningStateColors = {
  background: "var(--tandem-warning-bg)",
  border: "var(--tandem-warning-border)",
  color: "var(--tandem-warning)",
} as const;
