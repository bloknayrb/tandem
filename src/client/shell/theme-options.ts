import type { ThemePreference } from "../hooks/useTandemSettings.svelte";

/**
 * Canonical theme dropdown contents for the titlebar gear menu.
 *
 * The order matches the dropdown's intent (default-first), which differs
 * from `AppearanceSettings`' button row (light-first). Surfaces with a
 * different ordering or label policy should still import `THEME_VALUES`
 * for the underlying `ThemePreference[]` so the list of valid themes
 * stays single-source.
 */
export const THEME_OPTIONS = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: ThemePreference; label: string }[];

export const THEME_VALUES: readonly ThemePreference[] = THEME_OPTIONS.map((o) => o.value);
