/**
 * The `rearmWatch` site pin (#1749).
 *
 * ## What this pins, and why it is an AST walk and not a text scan
 *
 * Every `atomicWrite` / `atomicWriteBuffer` call in `src/` is acknowledged by
 * **(file, enclosing function name, count)**, and each is typed
 * `required` / `forbidden` / `n/a`. Not by file (too coarse: one file holds six
 * unrelated writes) and not by LINE — `integrations/apply.ts` carries six
 * acknowledged sites, so a 30-line insertion shifts five numbers and the repair
 * a contributor reaches for is `sed` on the numbers, which passes without
 * re-classifying anything.
 *
 * The key is the nearest enclosing NAMED SCOPE, computed by a real scope walk
 * (`node.parent` climb) rather than a text heuristic. Three successive text
 * rules were each defeated by a live line in this repo: "nearest bare `const`",
 * then "RHS begins `(`", then "RHS contains `=>`" — which mis-keyed
 * `const exportComments = prepareExportComments(doc, (reason) => {` and
 * `const enriched = exportable.map((ann) => ({`, three `required` rows among
 * them. An unrelated `const` inserted above a write can no longer re-key a row,
 * because the walk never reads siblings.
 *
 * ## The rule
 *
 * Match a `CallExpression` whose callee is the identifier `atomicWrite` or
 * `atomicWriteBuffer`, **or any local name a non-type-only `ImportSpecifier`
 * binds to one of those** (so `import { atomicWrite as aw }` keys `aw(`). The
 * two literal names are a floor, never replaced: an alias-only variant measures
 * `integrations/apply.ts` at ZERO, because that file imports no `atomicWrite`
 * and all six of its calls target its own LOCAL definition. `import { writeConfig
 * as atomicWrite }` would count a different function — both directions fail red.
 *
 * A definition is a `FunctionDeclaration`, never a `CallExpression`, so
 * `file-io/index.ts`'s two definitions and `integrations/apply.ts:899` are
 * skipped BY CONSTRUCTION and are deliberately NOT census rows. (`apply.ts:899`
 * is a different local `async function atomicWrite(content, dest, opts)` with
 * REVERSED parameters, which this census conflates by identifier. Harmless
 * while that file has no `required` row — but the "`rearmWatch`'s argument
 * equals the write's FIRST argument" rule below would be wrong there.)
 *
 * Then climb `node.parent` and stop at the FIRST ancestor that is either
 *   (a) a function-like node with a name — `FunctionDeclaration.name`,
 *       `MethodDeclaration.name`, or an `ArrowFunction`/`FunctionExpression`
 *       whose DIRECT parent is a `VariableDeclaration` (key = the declared
 *       identifier); or
 *   (b) a `CallExpression` whose callee text is `server.tool`, ends in `.tool`,
 *       or is the identifier `gatedTool`, and whose first argument is a string
 *       literal (key = that string).
 * Anonymous callbacks are passed THROUGH.
 *
 * **The parent check in (a) is the DIRECT parent, never a climb to the nearest
 * `VariableDeclaration`.** `integrations/apply.ts:2129-2133` is the live
 * instance — `const writeSkill = … ? … : (content, dest, writeSignal) =>
 * atomicWrite(…)`, whose arrow's parent is a `ConditionalExpression` — and the
 * census keys it `refreshExistingSkillIfStale`. A builder who climbs gets
 * `writeSkill`, a red row, and no fixture saying which spelling is intended.
 *
 * A `<module>` key (no ancestor matched — a top-level write, or an
 * `export default async () => …`) is an UNKNOWN key and FAILS. It is not
 * thrown, not keyed by filename, and not skipped.
 *
 * ## What the pin does NOT see (state it, do not oversell it)
 *
 * All measured at zero hits today, each an ADDED write site that would be
 * invisible and green: a namespace import (`fileIo.atomicWrite(`), a callback
 * reference (`withRetry(atomicWrite, p, c)`), a re-export under a new name, a
 * destructured `await import(…)`, a wrapper added inside an acknowledged file,
 * and a bare `fs.writeFile` on a document path. A net-zero swap — removing an
 * acknowledged non-document call and adding a document write in the same file
 * and function — also leaves key set and count identical.
 *
 * The REAL gate for the two `forbidden` rows is the ubuntu `check` run of the
 * "applyChanges completion" test: on Linux a `rearmWatch` there closes the old
 * handle with the write's `rename` still queued against it, `uv_fs_event_stop`
 * discards the event, and the reload never lands. On Windows `rearmWatch` is a
 * no-op, so the mistake passes locally.
 *
 * ## Expected false-red, named so the repair is the right one
 *
 * The `required` rows assert that `rearmWatch`'s argument is TEXTUALLY the same
 * expression as the write's first argument. A hoist —
 * `const target = …; atomicWrite(target, …); rearmWatch(docState.filePath)` —
 * is correct code that goes red here. The repair is "use the same expression",
 * not "loosen the check": in `saveDocumentAsToDisk` the write targets `resolved`
 * while `docState.filePath` is also in scope, and `rearmWatch(docState.filePath)`
 * re-arms the wrong path while satisfying a presence-only check.
 *
 * Likewise the second-argument equality unwraps `as` / `<T>` / parens on EITHER
 * side. `documents/reload-family.ts:301`/`:303` is the live instance requiring
 * it: the two write arms pass `content as Buffer` and `content as string` while
 * the single `recordSelfWrite` that serves both passes a bare `content`. A
 * naked equality is RED on correct code at two of the five `required` rows —
 * and loosening arg 2 re-opens the hole it exists to close, since
 * `recordSelfWrite(p, "")` would disarm layer 2, now the ONLY thing between a
 * self-write echo and a reload on POSIX.
 *
 * ## A6 coupling
 *
 * A6 deletes the `tandem_restoreBackup` row AND decrements `docx-apply.ts`'s
 * count 2 → 1. Two edits, both inside the table. `reload-family.ts` stays at 2
 * because A6 adds no write.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(REPO_ROOT, "src");

const WRITE_NAMES = ["atomicWrite", "atomicWriteBuffer"] as const;

type Rearm = "required" | "forbidden" | "n/a";

interface Acknowledged {
  file: string;
  key: string;
  count: number;
  rearm: Rearm;
  reason: string;
}

/**
 * The census, asserted by exact equality. `file → key → count` is the whole
 * table: a new site in a new function fails on an unknown key, a new site
 * inside an acknowledged function fails on the count (the count is the
 * load-bearing half; the key classifies).
 */
const CENSUS: Acknowledged[] = [
  {
    file: "server/mcp/document-service.ts",
    key: "saveDocumentToDisk",
    count: 2,
    rearm: "required",
    reason: "the two save arms (.docx buffer, text) — both write the open document",
  },
  {
    file: "server/mcp/document-service.ts",
    key: "saveDocumentAsToDisk",
    count: 1,
    rearm: "required",
    reason: "save-as write; the re-arm is a no-op today because nothing watches the new path yet",
  },
  {
    file: "server/mcp/docx-apply.ts",
    key: "applyChangesCore",
    count: 1,
    rearm: "forbidden",
    reason:
      "the watcher reload IS this write's designed completion; a re-arm discards the pending event",
  },
  {
    file: "server/mcp/docx-apply.ts",
    key: "tandem_restoreBackup",
    count: 1,
    rearm: "forbidden",
    reason:
      "sidecar restore, same shape as applyChangesCore — A6 deletes this row and the count with it",
  },
  {
    file: "server/documents/reload-family.ts",
    key: "restoreDocumentFromBackup",
    count: 2,
    rearm: "required",
    reason: "the two arms of one restore triple (docx buffer, text) — one try/finally covers both",
  },
  {
    file: "server/mcp/annotations.ts",
    key: "tandem_exportAnnotations",
    count: 1,
    rearm: "n/a",
    reason: "writes <base>.annotations.md|json beside the document, not the document",
  },
  {
    file: "server/mcp/convert.ts",
    key: "convertToMarkdown",
    count: 1,
    rearm: "n/a",
    reason:
      "always a NEW file via findAvailablePath, never an overwrite; openFromDisk wires its watcher after",
  },
  {
    file: "server/session/manager.ts",
    key: "saveSession",
    count: 1,
    rearm: "n/a",
    reason: "session file in SESSION_DIR",
  },
  {
    file: "server/session/manager.ts",
    key: "persistCtrlSnapshot",
    count: 1,
    rearm: "n/a",
    reason: "ctrl session file in SESSION_DIR",
  },
  {
    file: "server/annotations/store.ts",
    key: "performWrite",
    count: 1,
    rearm: "n/a",
    reason: "durable annotation envelope",
  },
  {
    file: "server/integrations/apply.ts",
    key: "applyConfig",
    count: 1,
    rearm: "n/a",
    reason: "Claude Code config file",
  },
  {
    file: "server/integrations/apply.ts",
    key: "removeConfigEntries",
    count: 1,
    rearm: "n/a",
    reason: "Claude Code config file",
  },
  {
    file: "server/integrations/apply.ts",
    key: "refreshMcpEntryBinary",
    count: 1,
    rearm: "n/a",
    reason: "Claude Code config file",
  },
  {
    file: "server/integrations/apply.ts",
    key: "refreshAllMcpEntryBinaries",
    count: 1,
    rearm: "n/a",
    reason: "Claude Code config file",
  },
  {
    file: "server/integrations/apply.ts",
    key: "installSkill",
    count: 1,
    rearm: "n/a",
    reason: "bundled skill file under ~/.claude/skills",
  },
  {
    file: "server/integrations/apply.ts",
    key: "refreshExistingSkillIfStale",
    count: 1,
    rearm: "n/a",
    reason:
      "bundled skill file; the arrow is an arm of a CONDITIONAL, so the key is the named function",
  },
];

// --- the walk ---------------------------------------------------------------

interface WriteSite {
  file: string;
  key: string;
  call: ts.CallExpression;
  source: ts.SourceFile;
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The matched call names for one file: the two literals PLUS any local name a
 *  non-type-only `ImportSpecifier` binds to them. A floor, never a replacement. */
function matchedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>(WRITE_NAMES);
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      if (spec.isTypeOnly) continue;
      const imported = (spec.propertyName ?? spec.name).text;
      if ((WRITE_NAMES as readonly string[]).includes(imported)) names.add(spec.name.text);
    }
  }
  return names;
}

function isToolRegistration(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression.getText(node.getSourceFile());
  const looksLikeTool =
    callee === "server.tool" || callee.endsWith(".tool") || callee === "gatedTool";
  return looksLikeTool && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]);
}

/** The nearest enclosing NAMED scope, or "<module>" when nothing matched. */
function enclosingKey(call: ts.CallExpression): string {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.parent &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.text;
    }
    if (isToolRegistration(node)) {
      return (node.arguments[0] as ts.StringLiteralLike).text;
    }
    node = node.parent;
  }
  return "<module>";
}

function collectWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const full of sourceFilesUnder(SRC)) {
    const text = fs.readFileSync(full, "utf-8");
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const names = matchedNames(source);
    const rel = path.relative(SRC, full).replace(/\\/g, "/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)
      ) {
        sites.push({ file: rel, key: enclosingKey(node), call: node, source });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

// --- expression comparison --------------------------------------------------

/** Strip `as T`, `<T>x` and `(x)` from either side before comparing text. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function textOf(node: ts.Expression): string {
  return unwrap(node).getText(node.getSourceFile()).trim();
}

/** The innermost `TryStatement` whose `tryBlock` encloses `node`. */
function innermostEnclosingTry(node: ts.Node): ts.TryStatement | null {
  let current: ts.Node | undefined = node.parent;
  let block: ts.Node = node;
  while (current) {
    if (ts.isTryStatement(current) && current.tryBlock === block) return current;
    block = current;
    current = current.parent;
  }
  return null;
}

function directCalls(block: ts.Block, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  for (const stmt of block.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    let expr: ts.Expression = stmt.expression;
    if (ts.isAwaitExpression(expr)) expr = expr.expression;
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === name
    ) {
      out.push(expr);
    }
  }
  return out;
}

/** Every `name(...)` call anywhere inside a block, in source order. */
function callsWithin(block: ts.Block, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return out;
}

// --- the assertions ---------------------------------------------------------

describe("document write / rearmWatch site pin (#1749)", () => {
  const sites = collectWriteSites();

  it("the census table IS the mechanical run — file → key → count by exact equality", () => {
    // This assertion is what makes "the rule reproduces the census" a green
    // check rather than a reviewer's word. Two earlier revisions of this spec
    // carried that sentence and it was false both times.
    const counted = new Map<string, number>();
    for (const site of sites) {
      const id = `${site.file}::${site.key}`;
      counted.set(id, (counted.get(id) ?? 0) + 1);
    }
    const observed = [...counted.entries()]
      .map(([id, count]) => {
        const [file, key] = id.split("::");
        return { file, key, count };
      })
      .sort((a, b) => `${a.file}${a.key}`.localeCompare(`${b.file}${b.key}`));

    const expected = CENSUS.map(({ file, key, count }) => ({ file, key, count })).sort((a, b) =>
      `${a.file}${a.key}`.localeCompare(`${b.file}${b.key}`),
    );

    expect(observed).toEqual(expected);
    // 18 write CALL sites. A `git grep` returns 21 lines; the three extra are
    // the definitions at `file-io/index.ts` (×2) and `integrations/apply.ts`,
    // which the walk skips by construction.
    expect(sites).toHaveLength(18);
  });

  it("no write site keys to <module>", () => {
    // An unknown key must FAIL rather than be thrown, keyed by filename, or
    // skipped — otherwise a top-level write or an `export default async () => …`
    // silently leaves the census.
    expect(sites.filter((s) => s.key === "<module>").map((s) => s.file)).toEqual([]);
  });

  it("every `required` row wraps its triple in an inner try/finally and re-arms the SAME path", () => {
    for (const row of CENSUS.filter((r) => r.rearm === "required")) {
      const rowSites = sites.filter((s) => s.file === row.file && s.key === row.key);
      expect(rowSites, `${row.file} :: ${row.key}`).toHaveLength(row.count);

      for (const site of rowSites) {
        const label = `${row.file} :: ${row.key} :: ${site.call.getText(site.source).slice(0, 60)}`;
        const target = textOf(site.call.arguments[0]);

        const tryStmt = innermostEnclosingTry(site.call);
        expect(tryStmt, `${label} — no enclosing try`).not.toBeNull();
        if (!tryStmt) continue;

        // No `catch`. The function-level `savingDocs` release HAS one, and that
        // is exactly the `finally` a builder must not reuse: it runs after
        // `saveSession`, and its `try` also covers the conflict skip-return and
        // the mtime guard — paths with no write at all, where the re-arm would
        // clear `suppressed` for nothing.
        expect(tryStmt.catchClause, `${label} — the inner try must have no catch`).toBeUndefined();
        expect(tryStmt.finallyBlock, `${label} — no finally`).toBeDefined();

        // The try wraps EXACTLY the suppress/write/record triple.
        const suppress = callsWithin(tryStmt.tryBlock, "suppressNextChange");
        expect(suppress.length, `${label} — no suppressNextChange in the try`).toBeGreaterThan(0);
        expect(textOf(suppress[0].arguments[0]), `${label} — suppressNextChange target`).toBe(
          target,
        );
        expect(
          suppress[0].getStart() < site.call.getStart(),
          `${label} — suppressNextChange must precede the write`,
        ).toBe(true);

        const last = tryStmt.tryBlock.statements[tryStmt.tryBlock.statements.length - 1];
        expect(
          ts.isExpressionStatement(last),
          `${label} — last try statement is not an expression`,
        ).toBe(true);
        const record = directCalls(tryStmt.tryBlock, "recordSelfWrite");
        expect(record.length, `${label} — no direct recordSelfWrite in the try`).toBe(1);
        expect(
          ts.isExpressionStatement(last) && last.expression === record[0],
          `${label} — the try's LAST statement must be recordSelfWrite`,
        ).toBe(true);

        // Both of `recordSelfWrite`'s arguments equal the write's, `as`/`<T>`/
        // parens unwrapped on either side. Arg 2 is the load-bearing half:
        // unpinned, `recordSelfWrite(p, "")` disarms layer 2 while passing
        // every other check here.
        expect(textOf(record[0].arguments[0]), `${label} — recordSelfWrite path`).toBe(target);
        expect(textOf(record[0].arguments[1]), `${label} — recordSelfWrite content`).toBe(
          textOf(site.call.arguments[1]),
        );

        // `rearmWatch` is a DIRECT ExpressionStatement of the finallyBlock —
        // not `if (cond) rearmWatch(p)`, not `queueMicrotask(() => …)`, not
        // `try { … } catch {}`, all of which pass a looser "inside it" phrasing.
        const rearm = directCalls(tryStmt.finallyBlock!, "rearmWatch");
        expect(rearm.length, `${label} — rearmWatch is not a direct statement of the finally`).toBe(
          1,
        );
        expect(textOf(rearm[0].arguments[0]), `${label} — rearmWatch target`).toBe(target);

        // Textual order, which is NOT vacuous under a `finally`:
        // `try { …write } finally { rearmWatch(p) } recordSelfWrite(p, out);`
        // is a legal spelling that inverts the runtime order, and this walker
        // is the only guard that sees it.
        expect(
          record[0].getStart() < rearm[0].getStart(),
          `${label} — recordSelfWrite must precede rearmWatch`,
        ).toBe(true);
      }
    }
    // Two residuals the strict form still admits, named here rather than
    // guarded: a `return;` before the re-arm (biome's `noUnsafeFinally` catches
    // that) and a throwing `await` before it.
  });

  it("`forbidden` files contain no reference to rearmWatch AT ALL", () => {
    // Whole-file scope, as §Fix states. A function-scope absence check is
    // beaten by one line of indirection and fails OPEN in that direction, and
    // these files have no legitimate use of the symbol.
    const forbiddenFiles = [
      ...new Set(CENSUS.filter((r) => r.rearm === "forbidden").map((r) => r.file)),
    ];
    expect(forbiddenFiles).toEqual(["server/mcp/docx-apply.ts"]);
    for (const rel of forbiddenFiles) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
      expect(text.includes("rearmWatch"), `${rel} must not reference rearmWatch`).toBe(false);
    }
  });

  it("the exported write primitives of file-io/index.ts are pinned", () => {
    // Companion pin: a new wrapper must be CLASSIFIED rather than inherit the
    // census by being adjacent to one. It catches the ordinary shape, not every
    // shape — see the residual list in this file's header.
    const text = fs.readFileSync(path.join(SRC, "server/file-io/index.ts"), "utf-8");
    const source = ts.createSourceFile(
      "index.ts",
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const exported: string[] = [];
    for (const stmt of source.statements) {
      const isExported = ts.canHaveModifiers(stmt)
        ? (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        : false;
      if (!isExported) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name && /write/i.test(stmt.name.text)) {
        exported.push(stmt.name.text);
      }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && /write/i.test(decl.name.text))
            exported.push(decl.name.text);
        }
      }
    }
    expect(exported.sort()).toEqual(["atomicWrite", "atomicWriteBuffer"]);
  });
});

// --- the seven fixtures, each a shape a dead text rule mis-keyed ------------

describe("the enclosing-scope rule, pinned by fixture", () => {
  function keysOf(code: string): string[] {
    const source = ts.createSourceFile(
      "fixture.ts",
      code,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const names = matchedNames(source);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)
      ) {
        out.push(enclosingKey(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  it("(1) an intervening `const code = (err as X).code;` does not re-key", () => {
    expect(
      keysOf(`
        async function saveThing(p: string, out: string) {
          const code = (err as NodeJS.ErrnoException).code;
          await atomicWrite(p, out);
        }
      `),
    ).toEqual(["saveThing"]);
  });

  it("(2) the INNERMOST tool registration wins over an outer one", () => {
    expect(
      keysOf(`
        gatedTool("tandem_y", async () => {
          server.tool(
            "tandem_x",
            async () => {
              await atomicWrite(p, out);
            },
          );
        });
      `),
    ).toEqual(["tandem_x"]);
  });

  it("(3) a plain `const x = 5;` above the write does not re-key", () => {
    expect(
      keysOf(`
        async function writeIt(p: string, out: string) {
          const x = 5;
          await atomicWrite(p, out);
        }
      `),
    ).toEqual(["writeIt"]);
  });

  it("(4) an anonymous `.map((a) => ({…}))` above the write does not re-key", () => {
    expect(
      keysOf(`
        async function exportThem(p: string) {
          const enriched = xs.map((a) => ({ ...a }));
          await atomicWrite(p, JSON.stringify(enriched));
        }
      `),
    ).toEqual(["exportThem"]);
  });

  it("(5) a write inside an anonymous callback keys the enclosing NAMED function", () => {
    expect(
      keysOf(`
        async function persistIt(doc: Doc, p: string) {
          withInternal(doc, () => {
            atomicWrite(p, "x");
          });
        }
      `),
    ).toEqual(["persistIt"]);
  });

  it("(6) a DEFINITION is not a write site", () => {
    expect(
      keysOf(`
        export async function atomicWrite(filePath: string, content: string): Promise<void> {
          await fs.writeFile(filePath, content);
        }
      `),
    ).toEqual([]);
  });

  it("(7) an arrow that is an arm of a CONDITIONAL keys the enclosing named function", () => {
    // The live instance is `integrations/apply.ts:2129-2133`. The arrow's
    // DIRECT parent is a `ConditionalExpression`, not a `VariableDeclaration`,
    // so clause (a) does not fire and the climb continues. A builder who
    // climbs to the nearest `VariableDeclaration` instead gets `writeSkill`.
    expect(
      keysOf(`
        async function refreshExistingSkillIfStale(dry: boolean) {
          const writeSkill = dry
            ? async () => {}
            : (content: string, dest: string, signal: AbortSignal) => atomicWrite(dest, content);
          await writeSkill("a", "b", s);
        }
      `),
    ).toEqual(["refreshExistingSkillIfStale"]);
  });

  it("an ImportSpecifier ALIAS is matched, and the two literal names are a floor", () => {
    expect(
      keysOf(`
        import { atomicWrite as aw } from "./file-io/index.js";
        async function saveAliased(p: string, out: string) {
          await aw(p, out);
          await atomicWriteBuffer(p, buf);
        }
      `),
    ).toEqual(["saveAliased", "saveAliased"]);
  });

  it("a type-only ImportSpecifier is not matched", () => {
    expect(
      keysOf(`
        import type { atomicWrite as aw } from "./file-io/index.js";
        async function nope(p: string) {
          aw(p);
        }
      `),
    ).toEqual([]);
  });
});
