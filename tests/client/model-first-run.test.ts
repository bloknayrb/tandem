import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ModelPickerOfferInput,
  shouldOfferModelPicker,
  wizardCloseReason,
} from "../../src/client/utils/model-first-run";
import type { ApplyItemResult } from "../../src/shared/integrations/contract";
import { readAppSource } from "../helpers/app-source";

/**
 * #1123, ADR-039 item 21 as amended by W1 ("Cheaper: tied to the setup
 * wizard"): the first-run local-model window is offered once, decided when the
 * integration wizard closes. The pure halves are tested here; App's wiring is
 * pinned from its comment-stripped source (nothing mounts App in tests).
 */

// Every input set so the window IS offered; each case below flips exactly one.
function offer(overrides: Partial<ModelPickerOfferInput> = {}): ModelPickerOfferInput {
  return {
    reason: "claude-set-up",
    autoOpened: true,
    manuallyReopened: false,
    walkthrough: false,
    loaded: true,
    savedModelCount: 0,
    wizardShowing: false,
    settingsOpen: false,
    helpOpen: false,
    paletteOpen: false,
    fileOpenDialogOpen: false,
    dismissed: false,
    pageCannotChangeModels: false,
    ...overrides,
  };
}

describe("shouldOfferModelPicker (R1.1)", () => {
  it("offers when Claude was set up in an auto-opened wizard and nothing else holds it back", () => {
    expect(shouldOfferModelPicker(offer())).toBe(true);
  });

  const notOffered: Array<[string, Partial<ModelPickerOfferInput>]> = [
    ["the wizard closed without setting Claude up", { reason: "other" }],
    ["the wizard did not open by itself", { autoOpened: false }],
    ["the wizard was taken over by hand", { manuallyReopened: true }],
    ["it was the v1.0 walkthrough (W1 edge 3)", { walkthrough: true }],
    ["the model list has not loaded", { loaded: false }],
    ["a model is saved, with no default (RW-1)", { savedModelCount: 1 }],
    ["the wizard still reads as showing", { wizardShowing: true }],
    ["Settings is open", { settingsOpen: true }],
    ["Help is open", { helpOpen: true }],
    ["the command palette is open", { paletteOpen: true }],
    ["the file-open dialog is open", { fileOpenDialogOpen: true }],
    ["the window was dismissed before", { dismissed: true }],
    ["the page is not Tandem's own window (#2404)", { pageCannotChangeModels: true }],
  ];
  for (const [name, o] of notOffered) {
    it(`not offered: ${name}`, () => {
      expect(shouldOfferModelPicker(offer(o))).toBe(false);
    });
  }
});

describe("wizardCloseReason", () => {
  const code = { id: "c", config: { kind: "claude-code" } };
  const desktop = { id: "d", config: { kind: "claude-desktop" } };
  const other = { id: "o", config: { kind: "other-mcp" } };
  const row = (id: string, status: ApplyItemResult["status"]): ApplyItemResult => ({ id, status });

  it("Done with a Claude Code row applied", () => {
    expect(wizardCloseReason("done", [row("c", "applied")], [code])).toBe("claude-set-up");
  });
  it("Done with a Claude Desktop row applied", () => {
    expect(wizardCloseReason("done", [row("d", "applied")], [desktop])).toBe("claude-set-up");
  });
  it("Done with a Claude row skipped or errored, or only other MCP applied", () => {
    expect(wizardCloseReason("done", [row("c", "skipped")], [code])).toBe("other");
    expect(wizardCloseReason("done", [row("d", "error")], [desktop])).toBe("other");
    expect(wizardCloseReason("done", [row("o", "applied")], [other])).toBe("other");
  });
  it("a row with no matching pick does not count", () => {
    expect(wizardCloseReason("done", [row("x", "applied")], [code])).toBe("other");
  });
  it("any other step is other, even with Claude rows applied", () => {
    for (const step of ["connect", "applying", "error"]) {
      expect(wizardCloseReason(step, [row("c", "applied")], [code])).toBe("other");
    }
  });
});

/** The body of `function <name>(` in the stripped App text, by brace count. */
function functionBody(app: string, name: string): string {
  const start = app.indexOf(`function ${name}(`);
  expect(start, `App defines ${name}`).toBeGreaterThan(-1);
  const open = app.indexOf("{", app.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}") {
      depth--;
      if (depth === 0) return app.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

/** The body of the dispatch-table entry `"<id>": (e…) => {`, by brace count. */
function dispatchBody(app: string, id: string): string {
  const start = app.indexOf(`"${id}": (e`);
  expect(start, `App dispatches ${id}`).toBeGreaterThan(-1);
  const open = app.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}") {
      depth--;
      if (depth === 0) return app.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${id}`);
}

// Pins read App's comment-stripped text (`readAppSource`), so a comment cannot
// satisfy one; the limits of that strip are in `tests/helpers/app-source.ts`.
describe("App.svelte wires the first-run local-model window (#1123, R1)", () => {
  const app = readAppSource();
  const close = functionBody(app, "closeIntegrationWizard");

  it("captures the wizard's state at the top of closeIntegrationWizard, before its writes", () => {
    const writes = [
      "dismissForVersion(",
      "wizardClosedLatch.mark()",
      "manuallyReopened = false",
    ].map((w) => {
      const at = close.indexOf(w);
      expect(at, w).toBeGreaterThan(-1);
      return at;
    });
    const firstWrite = Math.min(...writes);
    for (const capture of [
      "const closeWasAutoOpen = isAutoOpenFirstRun;",
      "const closeWasManual = manuallyReopened;",
      "const closeWasWalkthrough = firstRun.walkthrough;",
    ]) {
      const at = close.indexOf(capture);
      expect(at, capture).toBeGreaterThan(-1);
      expect(at, `${capture} before the first write`).toBeLessThan(firstWrite);
    }
  });

  it("decides after all three of the handler's writes, behind the flag, from the captured values", () => {
    const flat = close.replace(/\s+/g, " ");
    const decide = flat.indexOf("if ( BYO_MODELS_ENABLED && shouldOfferModelPicker(");
    expect(decide, "the offer statement").toBeGreaterThan(-1);
    // After the LAST of the three: a decision before `wizardClosedLatch.mark()`
    // or `dismissForVersion(` would read the closing wizard as still open.
    for (const write of [
      "dismissForVersion(",
      "wizardClosedLatch.mark()",
      "manuallyReopened = false",
    ]) {
      // The LAST occurrence: a second write after the decision (a scratch
      // second `wizardClosedLatch.mark()`) must fail this, not hide behind the first.
      const at = flat.lastIndexOf(write);
      expect(at, write).toBeGreaterThan(-1);
      expect(decide, `the decision after ${write}`).toBeGreaterThan(at);
    }
    // The whole argument, field by field: the wizard's own reason, the three
    // captures, the live store and dialog state read AFTER the writes (never a
    // value captured at the top), the dismissal and the page's own verdict.
    const call = flat.slice(flat.indexOf("shouldOfferModelPicker("));
    expect(call).toMatch(
      new RegExp(
        [
          "^shouldOfferModelPicker\\(\\{ reason,",
          "autoOpened: closeWasAutoOpen,",
          "manuallyReopened: closeWasManual,",
          "walkthrough: closeWasWalkthrough,",
          "loaded: modelsStore\\.loaded,",
          "savedModelCount: modelsStore\\.models\\.length,",
          "wizardShowing: shouldShowWizard,",
          "settingsOpen: settingsModalOpen,",
          "helpOpen: showHelp,",
          "paletteOpen,",
          "fileOpenDialogOpen,",
          "dismissed: modelPickerDismissed,",
          'pageCannotChangeModels: modelsPageAccess\\(\\) === "foreign",',
          "\\}\\) \\) modelPickerShown = true;",
        ].join(" "),
      ),
    );
    // `reason` is the handler's own parameter, defaulting to "other".
    expect(app).toMatch(
      /function closeIntegrationWizard\(reason: WizardCloseReason = "other"\): void \{/,
    );
  });

  it("writes modelPickerShown true once (in closeIntegrationWizard) and false once (in dismissModelPicker)", () => {
    // Declared exactly once, false, as `$state`.
    expect(app.match(/\blet modelPickerShown\b/g)).toHaveLength(1);
    expect(app).toContain("let modelPickerShown = $state(false);");
    // Every other write, in any assignment form (`=`, `||=`, `&&=`, `??=`).
    // The declaration is not a write.
    const writes = [
      ...app.matchAll(/(?<!let )\bmodelPickerShown\s*(\|\|=|&&=|\?\?=|=(?!=))\s*([^;\n]*)/g),
    ].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(writes.sort()).toEqual(["= false", "= true"]);
    expect(close).toMatch(/modelPickerShown = true;/);
    expect(functionBody(app, "dismissModelPicker")).toMatch(/modelPickerShown = false;/);
  });

  it("the wizard's close reason reaches closeIntegrationWizard", () => {
    // Passed by reference, so the wizard's `onClose(reason)` argument arrives.
    // A wrapper such as `() => closeIntegrationWizard()` would drop it.
    expect(app).toMatch(
      /<IntegrationWizardModal\s+open=\{true\}\s+onClose=\{closeIntegrationWizard\}/,
    );
  });

  it("mounts the window on the flag and the shown state alone", () => {
    expect(app).toMatch(
      /const modelPickerOpen = \$derived\(BYO_MODELS_ENABLED && modelPickerShown\);/,
    );
    expect(app).toMatch(
      /\{#if modelPickerOpen\}\s*<FirstRunModelPickerModal onComplete=\{dismissModelPicker\} \/>/,
    );
    // Exactly one mount, and the only block around it is that `{#if}`: a mount
    // nested under another condition, or a second mount elsewhere, could
    // unmount or remount a shown window (R1.2: once shown, it stays).
    const markup = app.slice(app.indexOf("</script>"));
    expect(markup.match(/<FirstRunModelPickerModal\b/g)).toHaveLength(1);
    const mountAt = markup.indexOf("<FirstRunModelPickerModal");
    const open: string[] = [];
    for (const m of markup
      .slice(0, mountAt)
      .matchAll(/\{#(if|each|await|key|snippet)\b[^}]*\}|\{\/(if|each|await|key|snippet)\}/g)) {
      if (m[1]) open.push(m[0]);
      else open.pop();
    }
    // The app shell's own block (its `{:else}` holds the whole app, the wizard
    // included; `yjsSync.ready` goes false only at teardown), then the
    // window's: nothing else.
    expect(open).toEqual(["{#if !yjsSync.ready}", "{#if modelPickerOpen}"]);
  });

  it("the tutorial waits behind the window (R1.5)", () => {
    expect(app).toContain("{#if tutorial.tutorialActive && !shouldShowWizard && !modelPickerOpen}");
  });

  it("nothing opens over the window (R1.4), each refusal before its handler opens anything", () => {
    const flat = (t: string) => t.replace(/\s+/g, " ");
    // Settings: the wizard's guard, then this one, as the first two statements.
    expect(flat(functionBody(app, "openSettingsModalWithAck"))).toMatch(
      /^\{ if \(shouldShowWizard\) return; if \(modelPickerOpen\) return; /,
    );
    // The file-open dialog: its first statement.
    expect(flat(functionBody(app, "requestOpenFile"))).toMatch(
      /^\{ if \(modelPickerOpen\) return Promise\.resolve\(\); return openFileForRuntime\(/,
    );
    // Help's shortcut: before it claims the key or toggles Help.
    const help = dispatchBody(app, "toggle-help");
    const helpGuard = help.indexOf("if (modelPickerOpen) return;");
    expect(helpGuard).toBeGreaterThan(-1);
    expect(helpGuard).toBeLessThan(help.indexOf("e.preventDefault()"));
    expect(helpGuard).toBeLessThan(help.indexOf("showHelp ="));
    // The palette: before the toggle.
    const palette = dispatchBody(app, "toggle-palette");
    const paletteGuard = palette.indexOf(
      "if (!untrack(() => paletteOpen) && modelPickerOpen) return;",
    );
    expect(paletteGuard).toBeGreaterThan(-1);
    expect(paletteGuard).toBeLessThan(
      palette.indexOf("paletteOpen = !untrack(() => paletteOpen);"),
    );
    expect(app).toMatch(
      /onOpenHelp=\{\(\) => \{\s*if \(!modelPickerOpen\) showHelp = true;\s*\}\}/,
    );
    // The comment shortcut does not open a composer or toast behind its scrim.
    const suppressed = app.indexOf("if (popupSuppressed) {");
    expect(suppressed).toBeGreaterThan(-1);
    expect(app.slice(suppressed, suppressed + 200)).toMatch(
      /if \(popupSuppressed\) \{[\s\S]*?return;\s*\}\s*if \(modelPickerOpen\) return;/,
    );
  });

  it("retries the model list on connect inside a .then, behind the flag, after a failed load, once per connection (R1.1a)", () => {
    const at = app.indexOf("modelsStore.reload()");
    expect(at).toBeGreaterThan(-1);
    const effect = app.slice(app.lastIndexOf("$effect(", at), at);
    expect(effect).toMatch(/if \(!BYO_MODELS_ENABLED\) return;/);
    expect(effect).toMatch(/yjsSync\.connected/);
    // Only after a FAILED load, never while one runs, never once loaded: a
    // retry before the boot load would load the pre-reconcile list.
    expect(effect).toMatch(
      /if \(modelsStore\.loaded \|\| !modelsStore\.loadFailed \|\| modelsStore\.loading\) return;/,
    );
    // The latch: a plain `let` (not `$state`), tested in an early return and
    // set before the continuation. Without it a failed retry would re-fire
    // this effect (it reads `loading`) against the server in a loop.
    expect(app).toContain("let modelsReloadTriedThisConnection = false;");
    const tested = effect.indexOf("if (modelsReloadTriedThisConnection) return;");
    const set = effect.indexOf("modelsReloadTriedThisConnection = true;");
    expect(tested).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(tested);
    expect(effect.indexOf(".then(")).toBeGreaterThan(set);
    // A disconnect re-arms the retry, so a later reconnect retries a failed one.
    expect(effect).toMatch(
      /if \(!yjsSync\.connected\) \{\s*modelsReloadTriedThisConnection = false;\s*return;\s*\}/,
    );
    expect(effect).toMatch(
      /\.then\(\(\) => \{\s*if \(!modelsStore\.loaded && !modelsStore\.loading\) return $/,
    );
    // Nothing else writes the latch: every assignment in App, in any form,
    // the declaration excluded, is the reset and the set above.
    const writes = [
      ...app.matchAll(
        /(?<!let )\bmodelsReloadTriedThisConnection\s*(\|\|=|&&=|\?\?=|=(?!=))\s*([^;\n]*)/g,
      ),
    ].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(writes.sort()).toEqual(["= false", "= true"]);
  });

  it("no longer derives the window from the registry", () => {
    expect(app).not.toMatch(/shouldShowModelPicker|resolveModelFirstRunNeeded/);
  });
});

// Nothing mounts App.svelte in tests, so the wiring of that input is pinned
// from source: the window's decision is fed the page's OWN origin verdict,
// which is fixed for a page load. It must not be fed the refusal latch.
describe("App.svelte feeds the window the page's own-window verdict (#2404)", () => {
  const app = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "client", "App.svelte"),
    "utf8",
  );

  it("pageCannotChangeModels is the page-origin classification, not the latch", () => {
    expect(app).toMatch(/pageCannotChangeModels:\s*modelsPageAccess\(\)\s*===\s*"foreign"/);
    expect(app).not.toMatch(/pageCannotChangeModels:[^\n]*blocked/);
  });
});
