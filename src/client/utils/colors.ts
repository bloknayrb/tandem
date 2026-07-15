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

/**
 * Inline-style fragment for a control that can be `disabled` (e.g. by the
 * forward-compat read-only settings store). One definition so the disabled
 * affordance (cursor + dimming) can't drift across the ~30 settings controls
 * that repeat it. `enabledCursor` covers sliders/text inputs whose enabled
 * cursor isn't `pointer`.
 */
export function disabledControlStyle(disabled: boolean, enabledCursor = "pointer"): string {
  return `cursor: ${disabled ? "not-allowed" : enabledCursor}; opacity: ${disabled ? 0.5 : 1};`;
}
