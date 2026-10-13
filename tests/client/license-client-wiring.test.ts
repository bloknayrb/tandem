/**
 * Source pins for the client half of #1521 that no mounted test can reach.
 *
 * `App.svelte` is never mounted in tests, and the selection composer's popup
 * needs a measured editor selection that happy-dom cannot produce, so these
 * read the source. Each pin names the regression it exists to catch.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Relative to the repo root, which is vitest's cwd (as `license-store.svelte.test.ts` reads it).
const read = (rel: string) => readFileSync(rel, "utf-8");

const APP = read("src/client/App.svelte");
const HARNESS = read("src/client/svelte-harness/AiReadinessHarness.svelte");
const TOOLBAR = read("src/client/editor/toolbar/Toolbar.svelte");

describe("App.svelte — the licence wall and Surface-A rebuild are gone (#1521)", () => {
  it("does not import or mount LicenseWall", () => {
    expect(APP).not.toContain("LicenseWall");
  });

  it("no licence input reaches editability", () => {
    const line = APP.split("\n").find((l) => l.includes("const editorReadOnly ="));
    expect(line).toBeDefined();
    expect(line).not.toContain("licenseStore");
    expect(line).toContain("$derived(isReadOnly)");
  });
});

describe("aiNotice reaches the readiness hook", () => {
  it("App passes it to createAiReadiness", () => {
    const call = APP.slice(APP.indexOf("createAiReadiness({"));
    expect(call.slice(0, call.indexOf("});"))).toContain(
      "aiNotice: () => licenseStore.ui.aiNotice",
    );
  });

  it("the test harness passes it too", () => {
    expect(HARNESS).toContain("aiNotice: () => aiNotice");
  });
});

/**
 * The pill and EmptyState read the refusal from READINESS, the same value that
 * makes `chip` `"unlicensed"` — never from `licenseStore` beside it, which is a
 * second source the two could disagree on.
 */
describe("the AI-off views read readiness's aiNotice", () => {
  it("StatusBar and EmptyState are both passed aiReadiness.aiNotice", () => {
    expect(APP.match(/aiNotice=\{aiReadiness\.aiNotice\}/g)?.length).toBe(2);
    expect(APP).not.toMatch(/aiNotice=\{licenseStore/);
  });
});

/**
 * The comment segment of the selection composer must be disabled while the AI
 * is off. A mount cannot open the popup (it needs a measured selection), so
 * this pins the binding and its source.
 */
describe("Toolbar — the comment segment", () => {
  it("is disabled from the licence store", () => {
    expect(TOOLBAR).toContain("const aiDisabled = $derived(licenseStore.ui.aiNotice !== null);");
    const seg = TOOLBAR.indexOf('data-testid="popup-comment-submit"');
    expect(seg).toBeGreaterThan(-1);
    const tag = TOOLBAR.slice(seg, TOOLBAR.indexOf(">", TOOLBAR.indexOf("onclick=", seg)));
    expect(tag).toContain("disabled={aiDisabled}");
  });

  it("submitAsComment refuses while the AI is off", () => {
    const fn = TOOLBAR.slice(TOOLBAR.indexOf("function submitAsComment() {"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(
      /^function submitAsComment\(\) \{\n\s+if \(aiDisabled\) return;/,
    );
  });
});
