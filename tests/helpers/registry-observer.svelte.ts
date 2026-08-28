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
 *
 * There is deliberately no `runs()` counter. An earlier version had one,
 * documented as "how many times the derived has re-run", and it could not
 * measure that: the `$effect` reads a `$derived` **boolean**, and Svelte
 * short-circuits a derived that recomputes to an equal value, so the effect
 * re-runs only when presence FLIPS. A spec written against it — say, asserting
 * that a batch registration is ONE reassignment rather than N — would score a
 * per-id loop identically. A counter that cannot distinguish the two cases it
 * exists to distinguish is worse than none.
 */

import { flushSync } from "svelte";
import { type Action, getActionsMap } from "../../src/client/actions/registry.svelte.js";

export interface RegistryObserver {
  /** Whether a `$derived` over the map currently sees the id. */
  present(): boolean;
  stop(): void;
}

export function observeRegistry(id: string): RegistryObserver {
  let present = false;

  const stop = $effect.root(() => {
    const found = $derived(Array.from(getActionsMap().values()).some((a: Action) => a.id === id));
    $effect(() => {
      present = found;
    });
  });
  flushSync();

  return {
    present() {
      flushSync();
      return present;
    },
    stop,
  };
}
