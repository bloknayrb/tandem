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
const EDITOR = read("src/client/editor/Editor.svelte");

/** The body of `function name(...) {` up to its closing brace at column 0. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("App.svelte — the licence wall and Surface-A rebuild are gone (#1521)", () => {
  it("does not import or mount LicenseWall", () => {
    expect(APP).not.toContain("LicenseWall");
  });

  it("no licence input reaches editability", () => {
    // A keyless install refuses the AI, never the editor (D3): every `readOnly`
    // binding is the document's own flag and nothing else.
    expect(APP).toContain("const isReadOnly = $derived(activeTab?.readOnly === true);");
    const bindings = APP.split("\n").filter((l) => /^\s+readOnly=\{/.test(l));
    expect(bindings.length).toBeGreaterThan(0);
    for (const l of bindings) expect(l.trim()).toBe("readOnly={isReadOnly}");
  });
});

/**
 * #2231: the grace-period tray notice. The decision is `planLicenseGraceNotice`
 * (unit-tested); this pins that App actually runs it, from an `$effect` over
 * the licence status, with the tray read and written under `untrack` — without
 * it the effect would depend on `notifications.activity`, and its own push
 * would re-run it.
 */
describe("App.svelte — the grace notice reaches the activity tray (#2231)", () => {
  it("runs the planner on licence status changes and applies its plan untracked", () => {
    const start = APP.indexOf("const status = licenseStore.status;");
    expect(start, "the grace $effect is gone").toBeGreaterThan(-1);
    const block = APP.slice(APP.lastIndexOf("$effect(() => {", start), start + 600);
    expect(block).toContain("untrack(() => {");
    expect(block).toContain("planLicenseGraceNotice({");
    expect(block).toContain("activity: notifications.activity");
    expect(block).toContain("notifications.dismissActivity(id)");
    expect(block).toContain("notifications.push(plan.push)");
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

  // At trial expiry the launcher can report `unlicensed` before the licence
  // poll does; readiness asks the store to catch up through this dep.
  it("App wires refreshLicence to the licence store's refresh", () => {
    const call = APP.slice(APP.indexOf("createAiReadiness({"));
    expect(call.slice(0, call.indexOf("});"))).toContain(
      "refreshLicence: () => licenseStore.refresh()",
    );
  });

  it("the test harness forwards refreshLicence", () => {
    expect(HARNESS).toContain("refreshLicence: () => refreshLicence()");
  });
});

/**
 * The pill and EmptyState read the refusal from READINESS, the same value that
 * makes `chip` `"ai-off"` — never from `licenseStore` beside it, which is a
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
    expect(TOOLBAR).toContain("const aiDisabled = $derived(licenseStore.ui.aiOff);");
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

/**
 * The keyboard paths into the composer. Ctrl/Cmd+Enter and the primary-intent
 * default both decide between a comment (an AI write) and a private note, so
 * each must be told the AI is off or it routes a refused comment.
 */
describe("Toolbar — the composer's keyboard and default intent", () => {
  it("handleComposerKeyDown passes aiDisabled to resolveAnnotationSubmission", () => {
    expect(fnBody(TOOLBAR, "handleComposerKeyDown")).toMatch(
      /resolveAnnotationSubmission\(\s*annotationIntent,\s*e,\s*aiDisabled\s*\)/,
    );
  });

  it("primaryAnnotationIntent passes aiDisabled to defaultAnnotationIntent", () => {
    expect(TOOLBAR).toMatch(
      /const primaryAnnotationIntent = \$derived\(\s*defaultAnnotationIntent\(\s*annotationIntent,\s*aiDisabled\s*\)/,
    );
  });
});

/** App is never mounted in tests; the chat rail's PanelSlot spreads its props into ChatPanel. */
describe("App — the chat panel", () => {
  it("is passed aiDisabled from the licence store", () => {
    const start = APP.indexOf('kind="chat"');
    expect(start).toBeGreaterThan(-1);
    const slot = APP.slice(start, APP.indexOf("/>", start));
    expect(slot).toMatch(/aiDisabled=\{licenseStore\.ui\.aiOff\}/);
  });
});

/**
 * `installContextMenu`'s own wiring is mounted in
 * `context-menu-install-licence.test.ts`; the Editor is not mountable here, so
 * the getter it hands over is pinned from source.
 */
describe("Editor — the native context menu", () => {
  it("hands installContextMenu a live read of the licence store", () => {
    const call = EDITOR.slice(EDITOR.indexOf("installContextMenu(next, {"));
    expect(call.slice(0, call.indexOf("});"))).toContain(
      "isAiDisabled: () => licenseStore.ui.aiOff",
    );
  });
});
