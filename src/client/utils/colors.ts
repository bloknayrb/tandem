/**
 * Tandem theme color utilities and constants.
 * Centralizes complex color computations (color-mix patterns) and semantic color references.
 */

/**
 * Error state color compositions using CSS custom properties.
 * These are used in banners, error dialogs, and validation feedback.
 */
export const errorStateColors = {
  /** Error background: 10% error color blended with surface */
  background: "color-mix(in srgb, var(--tandem-error) 10%, var(--tandem-surface))",

  /** Error border: 40% error color blended with border */
  border: "color-mix(in srgb, var(--tandem-error) 40%, var(--tandem-border))",
} as const;
