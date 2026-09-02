import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesMentioning, stripComments } from "../helpers/src-tree.js";

/**
 * How `App.svelte` wires `createTandemModeBroadcast` (#1621).
 *
 * ## Why a source-level check, when the parameter is already required
 *
 * Making `getCtrlSynced` required turns an OMITTED argument into a compile
 * error. It does nothing about a WRONG one, and the wrong one is the regression
 * review actually constructed:
 *
 * ```js
 * const ctrlSynced = yjsSync.ctrlInitialSyncComplete;   // no $derived
 * createTandemModeBroadcast(…, () => ctrlSynced, …);
 * ```
 *
 * That is a getter, it typechecks, `svelte-check` is clean, and every spec in
 * `tandem-mode-race.test.ts` stays green — because they drive the hook through a
 * fixture that supplies its own props and never touches this call
 * site. In the running app the getter is frozen at `false` forever: the mode is
 * never broadcast at all, `readModeState()` returns `indeterminate`,
 * `reportedMode` collapses that to `"tandem"`, and a user sitting in Solo has
 * their annotations shipped to Claude. #1621 turned from a coin flip into a
 * certainty, silently.
 *
 * The diff *invites* it, which is why this file exists rather than a comment:
 * the `const selectionDwellMs = $derived(...)` line immediately above
 * establishes the "narrow through a memo" idiom, and the next person applying it
 * to `ctrlInitialSyncComplete` without the `$derived` wrapper writes exactly the
 * shape above. Precedent for the instrument: `app-action-mount-contract.test.ts`,
 * which pins a composition fact for the same reason — losing it is silent.
 *
 * ## The controls are the load-bearing half
 *
 * A contract check that cannot fail is not a check. The matcher is extracted and
 * run over synthetic sources — the snapshot regression, a dropped argument, a
 * reordered pair, and a `$state` in place of `$derived` — plus the positive
 * control of the real shape. Without them this file would be green against a
 * matcher that returned `true` unconditionally.
 *
 * The fourth argument this file used to pin, `() => defaultMode`, is gone: #1623
 * was resolved by deleting the Settings default-mode control rather than wiring
 * it up, so the persisted last mode is now the only source of the startup mode.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const APP = join(ROOT, "src", "client", "App.svelte");
const HOOK = "src/client/hooks/useTandemModeBroadcast.svelte.ts";

/**
 * The argument list of the single `createTandemModeBroadcast(` call, split on
 * top-level commas only.
 *
 * Paren-depth aware rather than `split(",")`: an argument like
 * `() => foo(a, b)` contains a comma that is not an argument separator, and a
 * naive split would silently produce a longer list whose entries then fail to
 * match for the wrong reason.
 */
function modeBroadcastArgs(src: string): string[] | null {
  const code = stripComments(src);
  const open = code.indexOf("createTandemModeBroadcast(");
  if (open === -1) return null;
  let i = open + "createTandemModeBroadcast(".length;
  let depth = 1;
  const args: string[] = [];
  let current = "";
  for (; i < code.length && depth > 0; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth === 0) break;
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (depth !== 0) return null;
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/**
 * True when the wiring is live in every position that can silently revert a fix.
 *
 * Each getter body must be the reactive read ITSELF, not an identifier standing
 * in for one — except the `$derived` memo, which is matched by name and then
 * required to be declared as `$derived` of the settings field. Matching
 * `() => selectionDwellMs` without that second half would accept the snapshot
 * bug in the position where the idiom makes it most likely.
 */
function wiringIsLive(src: string): boolean {
  const args = modeBroadcastArgs(src);
  if (args === null || args.length !== 3) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (norm(args[0]) !== "() => yjsSync.bootstrapYdoc") return false;
  if (norm(args[1]) !== "() => selectionDwellMs") return false;
  if (norm(args[2]) !== "() => yjsSync.ctrlInitialSyncComplete") return false;
  const code = norm(stripComments(src));
  return code.includes(
    "const selectionDwellMs = $derived(settingsState.settings.selectionDwellMs)",
  );
}

const REAL_APP = readFileSync(APP, "utf8");

/** The real call, reduced to just the fragment the controls vary. */
const GOOD = `
const selectionDwellMs = $derived(settingsState.settings.selectionDwellMs);
const modeState = createTandemModeBroadcast(
  () => yjsSync.bootstrapYdoc,
  () => selectionDwellMs,
  () => yjsSync.ctrlInitialSyncComplete,
);
`;

describe("App.svelte wires the mode broadcast to live reactive reads", () => {
  it("matches the real App.svelte", () => {
    expect(wiringIsLive(REAL_APP)).toBe(true);
  });

  it("has exactly one call site in all of src/", () => {
    // A second construction — a new window model, a Tauri path, a test double
    // promoted into src — would not be covered by the matcher above, which reads
    // App.svelte only. This is the sweep that notices one arriving.
    expect(filesMentioning("createTandemModeBroadcast")).toEqual(["src/client/App.svelte", HOOK]);
  });

  describe("controls — each of these must be rejected", () => {
    it("accepts the good shape (positive control)", () => {
      expect(wiringIsLive(GOOD)).toBe(true);
    });

    it("rejects a const snapshot in place of the live sync read", () => {
      const bad = GOOD.replace(
        "() => yjsSync.ctrlInitialSyncComplete,",
        "() => ctrlSyncedSnapshot,",
      );
      expect(wiringIsLive(bad)).toBe(false);
    });

    it("rejects a dropped argument", () => {
      expect(wiringIsLive(GOOD.replace("  () => yjsSync.ctrlInitialSyncComplete,\n", ""))).toBe(
        false,
      );
    });

    it("rejects the dwell and sync getters being swapped", () => {
      const bad = GOOD.replace(
        "  () => selectionDwellMs,\n  () => yjsSync.ctrlInitialSyncComplete,\n",
        "  () => yjsSync.ctrlInitialSyncComplete,\n  () => selectionDwellMs,\n",
      );
      expect(wiringIsLive(bad)).toBe(false);
    });

    it("rejects $state where $derived is required, which does not re-read settings", () => {
      const bad = GOOD.replace(
        "const selectionDwellMs = $derived(settingsState.settings.selectionDwellMs);",
        "const selectionDwellMs = $state(settingsState.settings.selectionDwellMs);",
      );
      expect(wiringIsLive(bad)).toBe(false);
    });

    it("rejects a source with no call at all", () => {
      expect(wiringIsLive("const x = 1;\n")).toBe(false);
    });

    it("does not read the call out of a comment", () => {
      const bad = `// ${GOOD.replace(/\n/g, " ")}\nconst x = 1;\n`;
      expect(wiringIsLive(bad)).toBe(false);
    });
  });

  describe("the argument splitter", () => {
    it("does not split inside a nested call", () => {
      const src = "createTandemModeBroadcast(() => f(a, b), () => c);";
      expect(modeBroadcastArgs(src)).toEqual(["() => f(a, b)", "() => c"]);
    });

    it("returns null on an unbalanced call rather than a short list", () => {
      // Fails closed: a truncated read must not look like "fewer arguments",
      // which the matcher would report as a wiring regression at the wrong site.
      expect(modeBroadcastArgs("createTandemModeBroadcast(() => a,")).toBeNull();
    });
  });
});
