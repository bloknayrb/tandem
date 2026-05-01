import type { Component } from "svelte";

/**
 * Registry of Svelte components available in the dev harness.
 * Each entry is a lazy import: `() => import("../path/to/Component.svelte")`.
 * Subsequent PRs add entries here as components are ported from React.
 */
export const registry: Record<string, () => Promise<{ default: Component }>> = {};
