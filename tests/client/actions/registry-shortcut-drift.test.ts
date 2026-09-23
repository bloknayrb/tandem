// @vitest-environment happy-dom

/**
 * The registry `shortcut` string is display-only (Help modal fallback, command
 * palette hint) and is hand-written next to each builtin action, while the
 * chord that actually fires is `DEFAULT_BINDINGS` in `keybindings.ts`. For
 * every action that maps into the remappable set, the two must agree —
 * otherwise the palette advertises a chord that does nothing. Arrow keys are
 * spelled as words in the registry and as glyphs by `formatChord`; that
 * spelling difference is normalised, not treated as drift.
 */

import { describe, expect, it, vi } from "vitest";
import "../../../src/client/actions/builtin.svelte.js";
import {
  DEFAULT_BINDINGS,
  formatChord,
  REGISTRY_TO_SHORTCUT_ID,
} from "../../../src/client/actions/keybindings.js";
import { getActionsMap } from "../../../src/client/actions/registry.svelte.js";

vi.mock(import("../../../src/client/sentry.js"), () => ({ reportError: () => {} }));

const ARROW_WORDS: Record<string, string> = { "←": "Left", "→": "Right", "↑": "Up", "↓": "Down" };
const spelled = (label: string) => label.replace(/[←→↑↓]/g, (g) => ARROW_WORDS[g] ?? g);

describe("registry shortcut strings match DEFAULT_BINDINGS", () => {
  for (const [registryId, shortcutId] of Object.entries(REGISTRY_TO_SHORTCUT_ID)) {
    it(`${registryId} displays its default chord`, () => {
      const action = getActionsMap().get(registryId);
      expect(action, `registry has no "${registryId}" action`).toBeDefined();
      expect(action?.shortcut).toBe(spelled(formatChord(DEFAULT_BINDINGS[shortcutId])));
    });
  }
});
