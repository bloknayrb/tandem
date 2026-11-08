import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpSuccess,
  noCallerRefusalMessage,
  withErrorBoundary,
} from "../../src/server/mcp/response.js";
import { createMcpServer } from "../../src/server/mcp/server.js";
import { runWithMcpContext } from "../../src/server/sessions/context.js";
import {
  resetOwnershipForTests,
  setOwnershipTransportMode,
} from "../../src/server/sessions/ownership.js";
import { IMPORTS, resolveSpec } from "../helpers/import-graph.js";
import { allMcpSource, registeredToolNames } from "../helpers/mcp-source.js";
import { SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * Where the caller is resolved, and nowhere else (#2358, ADR-054; ownership
 * design §3.1).
 *
 * Ownership's check, claims and answered-once run only where the caller is
 * resolved: once, at the entry of `withErrorBoundary`, which passes it to the
 * handler explicitly. So no handler body may read the ambient request context.
 * This pins that from both sides:
 *
 * - **Source:** the context getters of `src/server/sessions/context.ts` are
 *   imported only by the caller resolver (`sessions/caller.ts`), plus
 *   `src/server/mcp/wake-url.ts`'s `isCurrentPeerLoopback` (PR 1b, #1952), and
 *   the resolver is imported only by the wrapper (`mcp/response.ts`). Every `.handleRequest(` in
 *   `src` runs inside `runWithMcpContext(`, so every dispatched request has a
 *   context to resolve from.
 * - **Runtime:** flag-on, every tool `createMcpServer` registers refuses a call
 *   with no caller before its body runs — which only the wrapper does, so
 *   every registered tool goes through it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTEXT = "src/server/sessions/context.ts";

/** Named imports from `context.ts`, per importing file, read off the AST. */
function contextImports(): Map<string, { names: string[]; namespace: boolean }> {
  const out = new Map<string, { names: string[]; namespace: boolean }>();
  // Which files import context.ts at all comes from the shared walk
  // (tests/helpers/import-graph.ts), which resolves every specifier shape and
  // fails closed; only those files are parsed for WHAT they import.
  for (const [file, targets] of IMPORTS) {
    if (file === CONTEXT || !targets.includes(CONTEXT)) continue;
    const sf = ts.createSourceFile(
      file,
      SRC_FILES.get(file) as string,
      ts.ScriptTarget.Latest,
      true,
    );
    // An import the AST cannot read as a static named import (a dynamic
    // `import()`, a re-export, a namespace or default import) launders the
    // getters, and is reported as such.
    const entry = { names: [] as string[], namespace: true };
    for (const stmt of sf.statements) {
      const spec =
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined;
      if (spec === undefined || resolveSpec(file, spec) !== CONTEXT) continue;
      if (ts.isExportDeclaration(stmt)) {
        entry.namespace = true;
        break;
      }
      const clause = (stmt as ts.ImportDeclaration).importClause;
      const bindings = clause?.namedBindings;
      if (clause?.name || !bindings || ts.isNamespaceImport(bindings)) {
        entry.namespace = true;
        break;
      }
      entry.namespace = false;
      for (const el of bindings.elements) entry.names.push((el.propertyName ?? el.name).text);
    }
    out.set(file, entry);
  }
  return out;
}

/** Exported function names of `context.ts`. */
function contextExports(): string[] {
  const sf = ts.createSourceFile(
    CONTEXT,
    SRC_FILES.get(CONTEXT) as string,
    ts.ScriptTarget.Latest,
    true,
  );
  return sf.statements
    .filter(ts.isFunctionDeclaration)
    .filter((d) => d.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    .map((d) => d.name?.text ?? "");
}

describe("the context getters have one reader (ownership design §3.1)", () => {
  it("derives the getter set from context.ts", () => {
    const getters = contextExports().filter((n) => n.startsWith("get"));
    expect(getters).toEqual(expect.arrayContaining(["getMcpContext", "getCurrentSessionId"]));
  });

  it("imports from context.ts are exactly the reviewed ones", () => {
    const imports = contextImports();
    for (const [file, e] of imports)
      expect(e.namespace, `${file} namespace/default import`).toBe(false);
    const named = Object.fromEntries([...imports].map(([f, e]) => [f, [...e.names].sort()]));
    // wake-url.ts's one getter, from PR 1b (#1952): whether the TCP peer is
    // loopback, and nothing that names a caller.
    expect(named).toEqual({
      "src/server/mcp/server.ts": ["runWithMcpContext"],
      "src/server/mcp/wake-url.ts": ["isCurrentPeerLoopback"],
      "src/server/sessions/caller.ts": ["getMcpContext"],
      "src/server/sessions/ownership.ts": ["runOutsideMcpContext"],
    });
  });

  // The resolver itself is the other half: a second caller of
  // `resolveToolCaller` would be a second place the caller is resolved, outside
  // the wrapper, so caller.ts has exactly one importer and the name appears
  // nowhere else in src.
  it("caller.ts is imported only by the wrapper (mcp/response.ts)", () => {
    const CALLER = "src/server/sessions/caller.ts";
    const importers = [...IMPORTS]
      .filter(([file, targets]) => file !== CALLER && targets.includes(CALLER))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual(["src/server/mcp/response.ts"]);
    const named = [...SRC_FILES]
      .filter(([f]) => f !== CALLER && f !== "src/server/mcp/response.ts")
      .filter(([, src]) => /\bresolveToolCaller\b/.test(stripComments(src)))
      .map(([f]) => f);
    expect(named).toEqual([]);
  });

  it("no tool handler reads the session id itself", () => {
    const hits = [...SRC_FILES]
      .filter(([f]) => f !== CONTEXT && /\.(ts|svelte)$/.test(f))
      .filter(([, src]) => /\bgetCurrentSessionId\b|\bgetMcpContext\b/.test(stripComments(src)))
      .map(([f]) => f);
    expect(hits).toEqual(["src/server/sessions/caller.ts"]);
  });

  it("every .handleRequest( call in src runs inside runWithMcpContext(", () => {
    let calls = 0;
    const naked: string[] = [];
    for (const [file, text] of SRC_FILES) {
      if (!/\.(ts|mts)$/.test(file)) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "handleRequest"
        ) {
          calls++;
          let p: ts.Node | undefined = node.parent;
          let wrapped = false;
          while (p) {
            if (
              ts.isCallExpression(p) &&
              ts.isIdentifier(p.expression) &&
              p.expression.text === "runWithMcpContext"
            ) {
              wrapped = true;
              break;
            }
            p = p.parent;
          }
          if (!wrapped) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            naked.push(`${file}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(naked).toEqual([]);
  });
});

describe("every registered tool goes through the wrapper (flag on)", () => {
  afterEach(() => {
    resetOwnershipForTests();
    vi.unstubAllEnvs();
  });

  it("each refuses a call with no caller before its body runs", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const server = createMcpServer();
    // `_registeredTools` is the SDK's private table (server.ts's
    // `snapshotToolCount` reads it too). Calling its handlers directly skips
    // zod, so a tool with required arguments still reaches the wrapper.
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
      }
    )._registeredTools;
    const names = Object.keys(tools).sort();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toEqual([...registeredToolNames(allMcpSource())].sort());
    for (const name of names) {
      const result = (await tools[name].handler({}, {})) as {
        content: Array<{ text: string }>;
      };
      const envelope = JSON.parse(result.content[0].text) as { code?: string; message?: string };
      expect(envelope.code, name).toBe("INTERNAL_ERROR");
      expect(envelope.message, name).toBe(noCallerRefusalMessage(name));
    }
  });

  it("the same call flag-off is not refused for want of a caller", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const server = createMcpServer();
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
      }
    )._registeredTools;
    const result = (await tools.tandem_listDocuments.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).not.toContain("no caller identity");
  });
});

describe("a request context without an owner record is refused (flag on)", () => {
  // In production every request dispatched to a registered transport carries
  // its ownerId; one that does not (a dispatch that lost the field, a tool
  // call riding the initialize context) is a wiring fault, refused — in HTTP
  // mode, and in stdio mode too, where only a context-free call is `local`.
  afterEach(() => {
    resetOwnershipForTests();
    vi.unstubAllEnvs();
  });

  it.each(["http", "stdio"] as const)("%s mode", async (mode) => {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    setOwnershipTransportMode(mode);
    const body = vi.fn(async () => mcpSuccess({ ran: true }));
    const result = await runWithMcpContext({ claudeSessionId: "x", mcpSessionId: "m" }, () =>
      withErrorBoundary("tandem_probe", body)({}),
    );
    expect(body).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).message).toBe(noCallerRefusalMessage("tandem_probe"));
  });
});

describe("the context propagation this rests on", () => {
  it("the SDK refuses a batch that carries an initialize, so no tool call rides the init context", () => {
    // The initialize request runs in a context with no ownerId (the record
    // does not exist until onsessioninitialized). That is safe only because
    // the SDK rejects a JSON-RPC batch containing an initialize — pinned
    // against the installed SDK's source, since package.json allows a range.
    const sdk = readFileSync(
      path.join(
        ROOT,
        "node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js",
      ),
      "utf-8",
    );
    expect(sdk).toMatch(/Only one initialization request is allowed/);
  });
});
