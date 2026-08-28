/**
 * Shallow composition contract for how `App.svelte` binds the action executor
 * (Unit 9).
 *
 * ## What it pins, and why a source-level check is the right instrument
 *
 * The invariant is a *composition* fact — "App binds the action dependency bag
 * to its own lifetime" — and it has no runtime signature short of mounting the
 * whole App with a Hocuspocus provider. Losing it is silent: delete the
 * `onDestroy` line and every test still passes, because the failure only shows
 * up after an ErrorBoundary recovery remounts App in a shipped build.
 *
 * ## Text position is not execution order, so the check is structural
 *
 * `App.svelte` already contains six other `onDestroy(` calls, so a loose "is
 * there an onDestroy somewhere near a dispose" scan would match across
 * unrelated ones, and a `mountActionExecutor` that had been moved inside a
 * helper function or an `{#if}` would keep it green while never running at
 * mount. The matcher therefore requires the mount call to be a **top-level
 * statement of the instance script** — column 0, the same nesting depth as the
 * `onDestroy` beside it — and requires that `onDestroy` to dispose *that
 * identifier*.
 *
 * ## What else is in this file
 *
 * The App matcher is one of four describes. The others sweep the whole client
 * for a rival mount site and for a re-export that would hide one, pin the shape
 * of the builtin registration, and pin the three call sites that opt into an
 * announced re-entry — that last one because the DEFAULT is easy to test and the
 * opt-ins are the actual user-facing fix, so deleting them is otherwise silent.
 *
 * ## The controls are the load-bearing half
 *
 * A contract check that cannot fail is not a check. The same extracted matcher
 * is run over seven synthetic sources plus two positive controls (the good
 * shape, and a block-bodied `onDestroy` arrow), each a way this could regress:
 * a missing `onDestroy`; disposing a different identifier; two mounts; a mount
 * nested inside a function body; a mount hoisted into `<script module>` or its
 * legacy `context="module"` spelling, both at column 0 and so past the
 * indentation test while running once per module load rather than once per App
 * instance; and a second mount sitting in markup next to an apostrophe, which
 * used to blank the rest of the file. Each must be rejected. Without them this
 * file would be green against a matcher that returned `true` unconditionally.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const APP_SVELTE = join(ROOT, "src", "client", "App.svelte");

interface ContractResult {
  ok: boolean;
  reason?: string;
}

/**
 * Offset of the `</script>` that closes the tag opened at `from`, or -1.
 *
 * A regex rather than `indexOf` because the opening-tag matches above are
 * case-insensitive (CodeQL js/bad-tag-filter reads a lowercase-only `<script`
 * match as a sanitiser with an uppercase bypass). Searching for a literal
 * lowercase closer while accepting `<SCRIPT>` would run an uppercase block to
 * end-of-file. Neither spelling occurs in `App.svelte` -- Svelte only honours
 * the lowercase tag -- so this is consistency, not a behaviour change.
 */
function closeScriptAt(src: string, from: number): number {
  const m = /<\/script\s*>/i.exec(src.slice(from));
  return m ? from + m.index : -1;
}

/**
 * The `<script>` spans of a Svelte file, as [from, to) offsets into `src`.
 * A file with no `<script` tag at all is one span covering everything — the
 * synthetic controls below are bare JavaScript.
 */
function scriptSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const tag of src.matchAll(/<script\b[^>]*>/gi)) {
    const from = tag.index + tag[0].length;
    const close = closeScriptAt(src, from);
    spans.push([from, close === -1 ? src.length : close]);
  }
  return spans.length > 0 ? spans : [[0, src.length]];
}

/** The `<script>` blocks that run once per MODULE rather than per instance. */
/**
 * Blank an HTML comment span to spaces, newlines preserved. Markup comments are
 * where most of the stray apostrophes live, and they are not code in any sense.
 */
function blankHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * One source string ready to match against: HTML comments gone, script spans
 * lexed as JavaScript, markup lexed without `'` as a string delimiter.
 * Offsets are preserved throughout, so `moduleScriptRanges` (which reads the RAW
 * source) and this can be compared directly.
 */
function prepare(rawSource: string): string {
  const src = blankHtmlComments(rawSource);
  const spans = scriptSpans(src);
  let out = "";
  let cursor = 0;
  for (const [from, to] of spans) {
    out += blankNonCode(src.slice(cursor, from), '"`');
    out += blankNonCode(src.slice(from, to));
    cursor = to;
  }
  out += blankNonCode(src.slice(cursor), '"`');
  return out;
}

/** The `<script>` blocks that run once per MODULE rather than per instance. */
function moduleScriptRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Read off the RAW source: `blankNonCode` would have blanked the quotes in
  // `context="module"`, which is exactly how the legacy spelling used to slip
  // past this check while the comment claimed it was covered.
  for (const tag of src.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = tag[1];
    if (!/\bmodule\b/.test(attrs) && !/\bcontext\s*=\s*["']module["']/.test(attrs)) continue;
    const from = tag.index;
    const close = closeScriptAt(src, from);
    ranges.push([from, close === -1 ? src.length : close]);
  }
  return ranges;
}

/**
 * Blank comments and string literals to spaces, so a mention of
 * `mountActionExecutor` inside a comment cannot satisfy — or, worse, break — a
 * count. Offsets are preserved so line/column reasoning stays valid.
 *
 * `quotes` is the load-bearing parameter and the reason this takes one at all.
 * Svelte markup is not JavaScript: an apostrophe in template prose or in an
 * `<!-- -->` comment ("the stack's wrapper", "#1431's fix") opens a pseudo-
 * string that runs to the next apostrophe, often a hundred lines later.
 * Measured with `'` enabled everywhere: 74 of 301 files under `src/client/` had
 * real code blanked, `App.svelte` 700 of 3064 lines — and those spans are the
 * input to BOTH the "exactly one mount" count and the repo-wide sweep, so a
 * rival `mountActionExecutor(` inside one was simply invisible.
 *
 * Blanking markup wholesale is not the fix either: `onclick={() => mount(…)}`
 * is a template expression, and it is real code. So `'` is a delimiter inside
 * `<script>` and not outside it. The residue is that a single-quoted string in
 * a template expression stays visible — which fails toward REPORTING, the safe
 * direction for this check.
 */
function blankNonCode(src: string, quotes = "\"'`"): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
    } else if (quotes.includes(src[i])) {
      const quote = src[i];
      out += " ";
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/**
 * The matcher. Exported shape is deliberately a plain function over a source
 * string so the real file and the synthetic controls go through exactly the
 * same code — a control that exercised a different path would prove nothing.
 */
export function checkActionMountContract(rawSource: string): ContractResult {
  const src = prepare(rawSource);

  // `[ \t]*`, never `\s*`: `\s` matches newlines, so a greedy run would swallow
  // the blank line above the statement and report phantom indentation.
  const mounts = [...src.matchAll(/(^|\n)([ \t]*)const\s+(\w+)\s*=\s*mountActionExecutor\s*\(/g)];
  const anyMountCall = [...src.matchAll(/mountActionExecutor\s*\(/g)];

  if (anyMountCall.length === 0) return { ok: false, reason: "no mountActionExecutor call" };
  if (anyMountCall.length > 1) {
    return { ok: false, reason: `expected exactly one mount, found ${anyMountCall.length}` };
  }
  if (mounts.length !== 1) {
    return { ok: false, reason: "mountActionExecutor result is not bound to a const" };
  }

  // `<script module>` (and its legacy `context="module"` spelling) runs ONCE
  // per module load, not per component instance — so a mount hoisted there is
  // at column 0, passes the indentation test below, and still never re-binds
  // after an ErrorBoundary recovery remounts App. That is precisely the failure
  // this contract exists to prevent, wearing the shape of a pass. Both spellings
  // have a control below; the legacy one is there because an earlier version of
  // this check read the blanked source and silently covered only the modern one.
  const offset = anyMountCall[0].index;
  if (moduleScriptRanges(rawSource).some(([from, to]) => offset >= from && offset < to)) {
    return {
      ok: false,
      reason: "mountActionExecutor is in the module script, not the instance script",
    };
  }

  const [, , indent, identifier] = mounts[0];
  // Top-level statement of the instance script. Any indentation means it sits
  // inside a function, a block, or a conditional — i.e. it may never run at
  // mount, which is the whole property being asserted.
  if (indent.length > 0) {
    return { ok: false, reason: "mountActionExecutor is not a top-level script statement" };
  }

  // The arrow may be expression-bodied or block-bodied; both are the same
  // contract, and pinning only the expression form would turn a harmless
  // reformat into a red test while teaching nothing.
  const disposePattern = new RegExp(
    `(^|\\n)onDestroy\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{?\\s*${identifier}\\.dispose\\s*\\(\\s*\\)`,
  );
  if (!disposePattern.test(src)) {
    return { ok: false, reason: `no top-level onDestroy disposing "${identifier}"` };
  }

  return { ok: true };
}

describe("App.svelte action-executor composition contract", () => {
  const source = readFileSync(APP_SVELTE, "utf-8");

  it("mounts the executor once at script scope and releases it in onDestroy", () => {
    const result = checkActionMountContract(source);
    expect(result.reason ?? "ok").toBe("ok");
    expect(result.ok).toBe(true);
  });

  it("no longer references the removed global wiring seam", () => {
    expect(source).not.toContain("wireActionDeps");
  });

  it("does not tear down the builtin REGISTRATION on unmount", () => {
    // Registration is module-scoped and runs once per page load. An
    // onDestroy-driven registry teardown would empty the palette of all its
    // builtins after an ErrorBoundary recovery, with nothing to put them back.
    expect(source).not.toContain("builtinRegistration");
    expect(source).not.toContain("unregisterAction");
  });
});

describe("the executor has exactly one mount site in the whole client", () => {
  it("is not re-exported, so no barrel can hide a call site from the sweep", () => {
    // The one hole `git grep` cannot cover: `export const bind =
    // mountActionExecutor;` in a barrel means the CALLING file never contains
    // the name at all, so it is never a candidate. Forbidding the re-export is
    // what keeps the candidate list complete.
    const out = execFileSync("git", ["grep", "-l", "--", "mountActionExecutor", "src/"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    const reexporters = out
      .split("\n")
      .filter(Boolean)
      .map((f) => f.trim().replace(/\\/g, "/"))
      .filter((rel) => {
        const src = prepare(readFileSync(join(ROOT, rel), "utf-8"));
        return (
          /export\s*\{[^}]*\bmountActionExecutor\b[^}]*\}/.test(src) ||
          /export\s+(?:const|let|var)\s+\w+\s*=\s*mountActionExecutor\b/.test(src)
        );
      });
    expect(reexporters).toEqual([]);
  });

  it("nothing outside App.svelte mounts an executor", () => {
    // The App.svelte matcher above is scoped to one file, so a second
    // `mountActionExecutor` in some other component would install a rival
    // `current` and pass every check in this file. The repo-wide sweep is what
    // makes "App owns the binding" a fact rather than a convention.
    //
    // `git grep` finds candidate FILES; the call sites are then counted through
    // `blankNonCode`, because prose is what most mentions of the name are — the
    // first draft of this spec failed on a comment in `builtin.svelte.ts` that
    // merely explains where the binding lives.
    const out = execFileSync("git", ["grep", "-l", "--", "mountActionExecutor", "src/"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    const candidates = out
      .split("\n")
      .filter(Boolean)
      .map((f) => f.trim().replace(/\\/g, "/"));

    const callers = candidates.filter((rel) => {
      const src = prepare(readFileSync(join(ROOT, rel), "utf-8"));
      // Key on the LOCAL BINDING, not the export name. `import { X as bind }`
      // then `bind({...})` installs a rival executor while a name-keyed scan
      // reports the file as a non-caller and drops it — the file still appears
      // in `git grep` (its import line names X), so the sweep goes green with
      // two executors live. The sibling `client-log-callsites.test.ts` already
      // guards its own scan this way.
      const names = new Set<string>();
      for (const imp of src.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"[^"]*actions\/executor[^"]*"/g,
      )) {
        for (const spec of imp[1].split(",")) {
          const m = /^\s*mountActionExecutor(?:\s+as\s+(\w+))?\s*$/.exec(spec);
          if (m) names.add(m[1] ?? "mountActionExecutor");
        }
      }
      // A file with no import of it can still be the declaring module.
      if (names.size === 0) names.add("mountActionExecutor");
      // Negative lookbehind so the DECLARATION in executor.ts is not counted as
      // a call site; without it the declaring module is indistinguishable from
      // a rival binder.
      return [...names].some((n) => new RegExp(`(?<!function\\s+)\\b${n}\\s*\\(`).test(src));
    });

    // executor.ts declares it; App.svelte calls it. Nothing else may.
    expect(callers.sort()).toEqual(["src/client/App.svelte"]);
  });
});

describe("builtin registration shape", () => {
  const BUILTIN = join(ROOT, "src", "client", "actions", "builtin.svelte.ts");
  // Comments and strings blanked: this file explains BOTH rejected designs in
  // prose, so a raw `toContain` reports the explanation as the violation.
  const source = prepare(readFileSync(BUILTIN, "utf-8"));

  it("declares its re-registration instead of relying on an HMR disposer", () => {
    // vite keys HMR disposers by `ownerPath` and looks them up by
    // `acceptedPath`; vite-plugin-svelte injects no `accept` into a `.svelte.ts`,
    // so a disposer registered here is never looked up and never fires. A
    // reintroduced one would read as working teardown while doing nothing.
    expect(source).not.toContain("import.meta.hot");
    expect(source).toMatch(/registerActions\(BUILTINS,\s*\{\s*replace:\s*true\s*\}\)/);
  });

  it("keeps the three user-initiated scratchpad call sites opting in", () => {
    // The DEFAULT (silent) is unit-tested; the OPT-INS are the user-facing fix,
    // and nothing else notices if they go. Deleting `{ announceBusy: true }`
    // from the palette entry, the Ctrl+N dispatch and the tab menu restores the
    // silent double-press with every spec still green.
    const sites: Array<[string, RegExp]> = [
      [
        "src/client/actions/builtin.svelte.ts",
        /createScratchpad\(\{\s*announceBusy:\s*true\s*\}\)/,
      ],
      ["src/client/App.svelte", /createScratchpad\(\{\s*announceBusy:\s*true\s*\}\)/],
      ["src/client/tabs/DocumentTabs.svelte", /createScratchpad\(\{\s*announceBusy:\s*true\s*\}\)/],
    ];
    for (const [rel, pattern] of sites) {
      expect(prepare(readFileSync(join(ROOT, rel), "utf-8")), rel).toMatch(pattern);
    }
    // And the debounced auto-open must NOT opt in — it has no gesture behind it.
    const app = prepare(readFileSync(join(ROOT, "src", "client", "App.svelte"), "utf-8"));
    expect(app.match(/createScratchpad\(/g)).toHaveLength(2);
    expect(app.match(/createScratchpad\(\{\s*announceBusy:\s*true\s*\}\)/g)).toHaveLength(1);
  });

  it("keeps the activity-tray Retry announcing an in-flight save", () => {
    // Same class: `triggerSave`'s guard backs a BUTTON, and the opt-in is one
    // deletable object literal away from a click that says nothing.
    const app = prepare(readFileSync(join(ROOT, "src", "client", "App.svelte"), "utf-8"));
    expect(app).toMatch(
      /triggerSave\(\s*action\.documentId\s*,\s*\{\s*announceBusy:\s*true\s*\}\s*\)/,
    );
  });

  it("does not bind registration to a component lifecycle", () => {
    // An onDestroy-driven registry teardown would empty the palette of every
    // builtin after an ErrorBoundary recovery, with nothing to put them back.
    expect(source).not.toContain("onDestroy");
  });
});

describe("the contract matcher can actually fail", () => {
  const GOOD = [
    "const actionExecutor = mountActionExecutor({",
    "  focusChat,",
    "});",
    "onDestroy(() => actionExecutor.dispose());",
  ].join("\n");

  it("accepts the shape it is meant to accept", () => {
    expect(checkActionMountContract(GOOD).ok).toBe(true);
  });

  const controls: [string, string][] = [
    [
      "mount with no onDestroy",
      "const actionExecutor = mountActionExecutor({});\nonDestroy(() => yjsSync.destroy());",
    ],
    [
      "onDestroy disposes a different identifier",
      "const actionExecutor = mountActionExecutor({});\nonDestroy(() => somethingElse.dispose());",
    ],
    [
      "two mounts",
      [
        "const a = mountActionExecutor({});",
        "onDestroy(() => a.dispose());",
        "const b = mountActionExecutor({});",
      ].join("\n"),
    ],
    [
      "mount nested inside a function body",
      [
        "function wire() {",
        "  const actionExecutor = mountActionExecutor({});",
        "  onDestroy(() => actionExecutor.dispose());",
        "}",
      ].join("\n"),
    ],
    [
      "mount hoisted into the module script",
      [
        "<script module>",
        "const actionExecutor = mountActionExecutor({});",
        "onDestroy(() => actionExecutor.dispose());",
        "</script>",
      ].join("\n"),
    ],
    [
      "mount hoisted into the LEGACY module script",
      [
        '<script context="module">',
        "const actionExecutor = mountActionExecutor({});",
        "onDestroy(() => actionExecutor.dispose());",
        "</script>",
      ].join("\n"),
    ],
    [
      "a second mount hidden in markup that an apostrophe would have blanked",
      [
        "<script>",
        "const actionExecutor = mountActionExecutor({});",
        "onDestroy(() => actionExecutor.dispose());",
        "</script>",
        "<!-- the tab's own wrapper -->",
        "<button onclick={() => mountActionExecutor({})}>go</button>",
      ].join("\n"),
    ],
  ];

  it.each(controls)("rejects: %s", (_name, src) => {
    expect(checkActionMountContract(src).ok).toBe(false);
  });

  it("accepts a block-bodied onDestroy arrow", () => {
    const src = [
      "const actionExecutor = mountActionExecutor({});",
      "onDestroy(() => {",
      "  actionExecutor.dispose();",
      "});",
    ].join("\n");
    expect(checkActionMountContract(src).ok).toBe(true);
  });

  it("is not satisfied by a mention inside a comment or a string", () => {
    const src = [
      "// const actionExecutor = mountActionExecutor({});",
      'const doc = "onDestroy(() => actionExecutor.dispose())";',
    ].join("\n");
    expect(checkActionMountContract(src).ok).toBe(false);
  });
});
