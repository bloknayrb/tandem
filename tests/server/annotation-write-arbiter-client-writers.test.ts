/**
 * #1920: the write arbiter (`src/server/annotations/write-arbiter.ts`) lets a
 * concurrent DELETE win over a remote `set` of the same key: a `set` landing on
 * a key the server already deleted is deleted again. That is only right if no
 * browser ever re-creates a key it has SEEN deleted — otherwise a deliberate
 * re-creation would be silently deleted too. Nothing enforces that at runtime,
 * so this scan pins the client contract: every `set` on the `Y_MAP_ANNOTATIONS`
 * map in `src/client` either writes under a key freshly minted by
 * `generateAnnotationId()` in the same function, or first reads the record by
 * that key and returns (or continues) when it is absent.
 *
 * What it recognises: a map bound in the same function as
 * `const <name> = <doc>.getMap(Y_MAP_ANNOTATIONS)` (type arguments allowed) and
 * then `<name>.set(key, …)`, or the inline
 * `<doc>.getMap(Y_MAP_ANNOTATIONS).set(key, …)`. A writer reaching the map
 * another way (a parameter, a helper) is invisible to it; the positive anchor
 * below at least fails if today's writers stop being found.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT = join(ROOT, "src", "client");

interface Writer {
  file: string;
  line: number;
  key: string;
  ok: boolean;
  why: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GET_MAP = String.raw`[\w.?]+\.getMap(?:<[^>]*>)?\(\s*Y_MAP_ANNOTATIONS\s*\)`;

/** Scan one source text. Exported shape kept local; `file` is only a label. */
function scan(file: string, src: string): Writer[] {
  const out: Writer[] = [];
  const lineOf = (pos: number) => src.slice(0, pos).split("\n").length;
  const windowAt = (pos: number) => {
    // The enclosing named function: the last `function name(` before the call.
    const re = /\bfunction\s+\w+\s*(?:<[^>]*>)?\s*\(/g;
    let start = 0;
    for (let m = re.exec(src); m && m.index < pos; m = re.exec(src)) start = m.index;
    return src.slice(start, pos);
  };

  const check = (pos: number, key: string, receiver: string | null): void => {
    const win = windowAt(pos);
    const k = esc(key);
    if (new RegExp(String.raw`\b${k}\s*=\s*generateAnnotationId\(\)`).test(win)) {
      out.push({ file, line: lineOf(pos), key, ok: true, why: "fresh id" });
      return;
    }
    const source = receiver ? `(?:${GET_MAP}|${esc(receiver)})` : GET_MAP;
    const read = new RegExp(String.raw`\b(\w+)\s*=\s*${source}\.get\(\s*${k}\s*\)`, "g");
    for (let m = read.exec(win); m; m = read.exec(win)) {
      const v = esc(m[1]);
      const guard = new RegExp(
        String.raw`if\s*\(\s*!${v}\b[^)]*\)\s*(?:\{[^}]*?\b(?:return|continue)\b|(?:return|continue)\b)`,
      );
      if (guard.test(win.slice(m.index))) {
        out.push({ file, line: lineOf(pos), key, ok: true, why: "presence check" });
        return;
      }
    }
    if (receiver) {
      const has = new RegExp(
        String.raw`if\s*\(\s*!${esc(receiver)}\.has\(\s*${k}\s*\)\s*\)\s*(?:\{[^}]*?\b)?(?:return|continue)\b`,
      );
      if (has.test(win)) {
        out.push({ file, line: lineOf(pos), key, ok: true, why: "presence check" });
        return;
      }
    }
    out.push({
      file,
      line: lineOf(pos),
      key,
      ok: false,
      why: "neither a fresh id nor a presence check",
    });
  };

  // Inline: `<doc>.getMap(Y_MAP_ANNOTATIONS).set(key, …)`.
  const inline = new RegExp(String.raw`${GET_MAP}\.set\(\s*([^,()]+?)\s*,`, "g");
  for (let m = inline.exec(src); m; m = inline.exec(src)) check(m.index, m[1], null);

  // Bound: `const name = <doc>.getMap(Y_MAP_ANNOTATIONS)` … `name.set(key, …)`.
  const names = new Set<string>();
  const bind = new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*${GET_MAP}`, "g");
  for (let m = bind.exec(src); m; m = bind.exec(src)) names.add(m[1]);
  for (const name of names) {
    const set = new RegExp(String.raw`\b${esc(name)}\.set\(\s*([^,()]+?)\s*,`, "g");
    for (let m = set.exec(src); m; m = set.exec(src)) {
      const win = windowAt(m.index);
      // Only where `name` is the annotations map in this function; the same
      // name bound to another map elsewhere in the file is not a writer.
      const local = new RegExp(String.raw`\b(?:const|let)\s+${esc(name)}\s*=\s*([^;\n]+)`, "g");
      let binding: string | undefined;
      for (let b = local.exec(win); b; b = local.exec(win)) binding = b[1];
      if (binding === undefined || !/Y_MAP_ANNOTATIONS\b/.test(binding)) continue;
      check(m.index, m[1], name);
    }
  }
  return out;
}

function clientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...clientFiles(p));
    else if (/\.(ts|svelte)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const writers = clientFiles(CLIENT).flatMap((p) =>
  scan(relative(ROOT, p).replace(/\\/g, "/"), readFileSync(p, "utf8")),
);

describe("browser writers of the annotations map (#1920 delete-wins contract)", () => {
  it("finds today's writers (the scan is not vacuous)", () => {
    const count = (file: string) => writers.filter((w) => w.file === file).length;
    expect(count("src/client/editor/toolbar/highlight-toggle.ts")).toBeGreaterThanOrEqual(2);
    expect(count("src/client/panels/annotation-actions.ts")).toBeGreaterThanOrEqual(4);
    expect(count("src/client/panels/useAnnotationReview.svelte.ts")).toBeGreaterThanOrEqual(4);
    expect(count("src/client/editor/toolbar/Toolbar.svelte")).toBeGreaterThanOrEqual(1);
  });

  it("every one writes a fresh id or returns when the record is absent", () => {
    expect(writers.filter((w) => !w.ok)).toEqual([]);
  });

  it("the scan flags a writer that does neither, and accepts both legal shapes", () => {
    const bad = scan(
      "bad.ts",
      `function reCreate(ydoc, id, ann) {
        const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
        withBrowser(ydoc, () => map.set(id, ann));
      }
      function inlineBad(ydoc, id, ann) {
        withBrowser(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, ann));
      }
      function readNoGuard(ydoc, id) {
        const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
        const raw = map.get(id);
        map.set(id, { ...raw, status: "accepted" });
      }`,
    );
    expect(bad.map((w) => w.ok)).toEqual([false, false, false]);

    const good = scan(
      "good.ts",
      `function create(ydoc, ann) {
        const id = generateAnnotationId();
        withBrowser(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, ann));
      }
      function edit(ydoc, id) {
        const map = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
        const raw = map.get(id);
        if (!raw || raw.status !== "pending") {
          cleanup();
          return false;
        }
        withBrowser(ydoc, () => map.set(id, { ...raw, status: "accepted" }));
      }
      function other(ctrl) {
        const map = ctrl.getMap(Y_MAP_USER_AWARENESS);
        map.set(KEY, 1);
      }`,
    );
    expect(good.map((w) => w.ok)).toEqual([true, true]);
  });
});
