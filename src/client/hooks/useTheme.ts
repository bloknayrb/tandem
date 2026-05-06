export type ResolvedTheme = "light" | "dark";

// systemTheme, resolveTheme, applyTheme live in useTheme.svelte.ts — they need
// access to tauriTheme (a Svelte $state) for live OS theme updates in Tauri.

// React hook removed — utilities migrated to useTheme.svelte.ts
