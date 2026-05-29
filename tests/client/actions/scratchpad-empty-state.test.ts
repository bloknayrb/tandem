// @vitest-environment happy-dom

/**
 * Unit coverage for the pure auto-open-scratchpad gate (#842).
 *
 * When the user reaches the empty tab-bar state with a live connection,
 * App.svelte debounces and then opens a fresh scratchpad rather than leaving
 * them on "No document open." The timing logic (debounce, startup-doc
 * precedence) lives in the App.svelte `$effect`, but the decision of *whether*
 * the empty state qualifies is extracted into `shouldAutoOpenScratchpad` so the
 * three correctness-critical guards can be asserted without standing up a
 * Svelte component or a Hocuspocus provider:
 *
 *   1. Never fire while disconnected — the disconnect-debounce window must show
 *      "Cannot reach the Tandem server", not spawn a scratchpad. The gate fails
 *      because `connected` is false.
 *   2. Never fire when a doc is still open (`tabCount > 0` or `activeTabId`
 *      set) — this is the normal editing case.
 *   3. Fire only when connected AND no tab AND no active id.
 */

import { describe, expect, it } from "vitest";
import { shouldAutoOpenScratchpad } from "../../../src/client/actions/builtin.svelte.js";

describe("shouldAutoOpenScratchpad", () => {
  it.each([
    {
      why: "connected + empty tab bar + no active id → genuine empty state",
      connected: true,
      tabCount: 0,
      activeTabId: null,
      expected: true,
    },
    {
      why: "disconnected (disconnect-debounce window) → never auto-open",
      connected: false,
      tabCount: 0,
      activeTabId: null,
      expected: false,
    },
    {
      why: "a tab is still open → normal editing, not empty state",
      connected: true,
      tabCount: 1,
      activeTabId: "doc-1",
      expected: false,
    },
    {
      why: "tabs present but no active id (reconcile churn) → not empty state",
      connected: true,
      tabCount: 2,
      activeTabId: null,
      expected: false,
    },
    {
      why: "active id set but tab list momentarily empty (swap churn) → wait",
      connected: true,
      tabCount: 0,
      activeTabId: "doc-1",
      expected: false,
    },
    {
      why: "disconnected with a tab still open → never auto-open",
      connected: false,
      tabCount: 1,
      activeTabId: "doc-1",
      expected: false,
    },
  ])("$why", ({ connected, tabCount, activeTabId, expected }) => {
    expect(shouldAutoOpenScratchpad({ connected, tabCount, activeTabId })).toBe(expected);
  });
});
