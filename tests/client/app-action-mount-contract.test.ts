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
 * is run over four synthetic sources, each a way this could regress:
 * a missing `onDestroy`; disposing a different identifier; two mounts; and a
 * mount nested inside a function body. Each must be rejected. Without them this
 * file would be green against a matcher that returned `true` unconditionally.
 */

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

  const [, , indent, identifier] = mounts[0];
  // Top-level statement of the instance script. Any indentation means it sits
  // inside a function, a block, or a conditional — i.e. it may never run at
  // mount, which is the whole property being asserted.
  if (indent.length > 0) {
    return { ok: false, reason: "mountActionExecutor is not a top-level script statement" };
  }

  const disposePattern = new RegExp(
    `(^|\\n)onDestroy\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*${identifier}\\.dispose\\s*\\(\\s*\\)\\s*\\)`,
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
  ];

  it.each(controls)("rejects: %s", (_name, src) => {
    expect(checkActionMountContract(src).ok).toBe(false);
  });

  it("is not satisfied by a mention inside a comment or a string", () => {
    const src = [
      "// const actionExecutor = mountActionExecutor({});",
      'const doc = "onDestroy(() => actionExecutor.dispose())";',
    ].join("\n");
    expect(checkActionMountContract(src).ok).toBe(false);
  });
});
