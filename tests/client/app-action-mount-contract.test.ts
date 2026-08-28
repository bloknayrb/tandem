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
 * ## The controls are the load-bearing half
 *
 * A contract check that cannot fail is not a check. The same extracted matcher
 * is run over five synthetic sources, each a way this could regress:
 * a missing `onDestroy`; disposing a different identifier; two mounts; a mount
 * nested inside a function body; and a mount hoisted into `<script module>`,
 * which is at column 0 and so defeats the indentation test while running once
 * per module load rather than once per App instance. Each must be rejected.
 * Without them this file would be green against a matcher that returned `true`
 * unconditionally.
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
 * Blank comments and string literals to spaces before matching, so a mention of
 * `mountActionExecutor` inside a comment cannot satisfy — or, worse, break — a
 * count. Offsets are preserved so line/column reasoning stays valid.
 */
function blankNonCode(src: string): string {
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
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
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
  const src = blankNonCode(rawSource);

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
  // this contract exists to prevent, wearing the shape of a pass.
  const moduleScript = /<script\b[^>]*\b(module\b|context\s*=\s*.module.)[^>]*>/.exec(src);
  if (moduleScript) {
    const end = src.indexOf("</script>", moduleScript.index);
    const stop = end === -1 ? src.length : end;
    if (anyMountCall[0].index >= moduleScript.index && anyMountCall[0].index < stop) {
      return {
        ok: false,
        reason: "mountActionExecutor is in the module script, not the instance script",
      };
    }
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
      const src = blankNonCode(readFileSync(join(ROOT, rel), "utf-8"));
      // Negative lookbehind so the DECLARATION in executor.ts is not counted as
      // a call site; without it the declaring module is indistinguishable from
      // a rival binder.
      return /(?<!function\s+)mountActionExecutor\s*\(/.test(src);
    });

    // executor.ts declares it; App.svelte calls it. Nothing else may.
    expect(callers.sort()).toEqual(["src/client/App.svelte"]);
  });
});

describe("builtin registration shape", () => {
  const BUILTIN = join(ROOT, "src", "client", "actions", "builtin.svelte.ts");
  // Comments and strings blanked: this file explains BOTH rejected designs in
  // prose, so a raw `toContain` reports the explanation as the violation.
  const source = blankNonCode(readFileSync(BUILTIN, "utf-8"));

  it("declares its re-registration instead of relying on an HMR disposer", () => {
    // vite keys HMR disposers by `ownerPath` and looks them up by
    // `acceptedPath`; vite-plugin-svelte injects no `accept` into a `.svelte.ts`,
    // so a disposer registered here is never looked up and never fires. A
    // reintroduced one would read as working teardown while doing nothing.
    expect(source).not.toContain("import.meta.hot");
    expect(source).toMatch(/registerActions\(BUILTINS,\s*\{\s*replace:\s*true\s*\}\)/);
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
