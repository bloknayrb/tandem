import type { ThemePreference } from "../hooks/useTandemSettings.svelte";

export const THEME_OPTIONS = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: ThemePreference; label: string }[];
