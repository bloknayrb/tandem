/**
 * Observe the action registry the way its real consumers do.
 *
 * This lives in a `.svelte.ts` file because runes are only available in one —
 * a plain `.test.ts` throws `rune_outside_svelte` — and it exists at all
 * because reading `getActionsMap()` directly cannot tell the two registry
 * implementations apart.
 *
 * `actionsMap` is `$state(new Map(...))` and Svelte 5 does not proxy a `Map`,
 * so a mutating `.delete(id)` produces a map that *reads* correctly while never
 * invalidating anything. CommandPalette, HelpModal and ShortcutEditorList all
 * read by iterating inside a `$derived.by`, so under a mutating delete they
 * would keep rendering a removed action. Only a derived observer — this — can
 * fail on that.
 */

import { flushSync } from "svelte";
import { type Action, getActionsMap } from "../../src/client/actions/registry.svelte.js";

export interface RegistryObserver {
  /** Whether a `$derived` over the map currently sees the id. */
  present(): boolean;
  /** How many times the derived has re-run. */
  runs(): number;
  stop(): void;
}

export function observeRegistry(id: string): RegistryObserver {
  let present = false;
  let runs = 0;

  const stop = $effect.root(() => {
    const found = $derived(Array.from(getActionsMap().values()).some((a: Action) => a.id === id));
    $effect(() => {
      present = found;
      runs += 1;
    });
  });
  flushSync();

  return {
    present() {
      flushSync();
      return present;
    },
    runs() {
      flushSync();
      return runs;
    },
    stop,
  };
}
