import type { Server } from "node:http";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { SRC_FILES } from "../helpers/src-tree.js";

/**
 * Source and wire pins the ownership identity rests on (#2358, ADR-054).
 */

describe("each transport branch tells the ownership module its mode before serving (ownership design §3.1 rule 4)", () => {
  // `main()` cannot be run in a unit test (tests/server/index.startup-ordering.test.ts
  // says why), so its order is pinned from source, as that file pins others.
  const src = SRC_FILES.get("src/server/index.ts") as string;
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `index.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("HTTP: mode, then the boot default rule, then the servers start", () => {
    const branch = at('if (transportMode === "http") {\n    // Ownership');
    const mode = at('setOwnershipTransportMode("http");');
    const boot = src.indexOf("applyUserOpenDefaultToDocuments(getOpenDocs().keys());", branch);
    const start = at("const [srv] = await Promise.all([");
    expect(branch < mode && mode < boot && boot < start).toBe(true);
  });

  it("stdio: mode, then the boot default rule, then Hocuspocus and MCP start", () => {
    const mode = at('setOwnershipTransportMode("stdio");');
    const boot = src.indexOf("applyUserOpenDefaultToDocuments(getOpenDocs().keys());", mode);
    const hocus = src.indexOf("await startHocuspocus(wsPort);", mode);
    const mcp = at("await startMcpServerStdio({ wsPort, mcpPort });");
    expect(mode < boot && boot < hocus && hocus < mcp).toBe(true);
    // Each mode is set exactly once, as a literal, never from the env string.
    expect(src.match(/setOwnershipTransportMode\(/g)).toHaveLength(2);
    expect(src).not.toMatch(/setOwnershipTransportMode\(\s*transportMode/);
  });
});

describe("an ownership entry's sinceSeq has a real source in a running server (ownership design §2; PR 2a)", () => {
  // `setOwnershipSeqSource` is a seam that answers 0 when nothing wires it, so
  // every unit test passes without the wiring: an unwired server would stamp
  // `sinceSeq: 0` on every entry and nothing would notice until PR 2b's
  // handed-or-not test read it. `main()` cannot be run in a unit test, so the
  // call is pinned from source. (`ownership-claim-at-outcome.test.ts` drives
  // the same source expression against the real registry.)
  const src = SRC_FILES.get("src/server/index.ts") as string;

  it("index.ts wires the delivery registry's counter, once, before either transport branch", () => {
    const call = "setOwnershipSeqSource(() => deliveryRegistry.counter);";
    expect(src.split(call)).toHaveLength(2);
    expect(src.match(/setOwnershipSeqSource\(/g)).toHaveLength(1);
    const wired = src.indexOf(call);
    const http = src.indexOf('if (transportMode === "http") {\n    // Ownership');
    const stdio = src.indexOf('setOwnershipTransportMode("stdio");');
    expect(http).toBeGreaterThan(-1);
    expect(stdio).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(http);
    expect(wired).toBeLessThan(stdio);
    // The registry the inbox itself assigns from, not a second instance.
    expect(src).toMatch(/import \{ deliveryRegistry \} from "\.\/mcp\/inbox-cursor\.js";/);
    const awareness = SRC_FILES.get("src/server/mcp/awareness.ts") as string;
    expect(awareness).toMatch(/\bdeliveryRegistry,\s[^;]*from "\.\/inbox-cursor\.js";/);
  });

  it("nothing else in src calls the seam: a second call would wire a different source", () => {
    const callers = [...SRC_FILES]
      .filter(([, text]) => /\bsetOwnershipSeqSource\(/.test(text))
      .map(([file]) => file)
      .sort();
    // `ownership.ts` is the definition (`export function setOwnershipSeqSource(`).
    expect(callers).toEqual(["src/server/index.ts", "src/server/sessions/ownership.ts"]);
    const ownership = SRC_FILES.get("src/server/sessions/ownership.ts") as string;
    expect(ownership.match(/\bsetOwnershipSeqSource\(/g)).toHaveLength(1);
  });

  it("the wiring is not inside a function or a branch that may not run", () => {
    const line = src.split("\n").find((l) => l.includes("setOwnershipSeqSource(() =>")) as string;
    // Two spaces: a statement of `main()` itself, as the mode calls' branch is.
    expect(line).toBe("  setOwnershipSeqSource(() => deliveryRegistry.counter);");
  });
});

describe("the handover is wired in a running server, and reachable only through the ownership module (ownership design §6.3)", () => {
  // `setOwnershipInboxHandover` is a seam that does nothing when unwired, so
  // every unit test passes without the wiring: an unwired server would run
  // every handover and re-owe nothing. `main()` cannot be run in a unit test,
  // so the call is pinned from source. (`ownership-handover.test.ts` wires the
  // same two expressions against the real inbox.)
  const index = SRC_FILES.get("src/server/index.ts") as string;
  const ownership = SRC_FILES.get("src/server/sessions/ownership.ts") as string;
  const awareness = SRC_FILES.get("src/server/mcp/awareness.ts") as string;
  const filesNaming = (pattern: RegExp) =>
    [...SRC_FILES]
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file)
      .sort();
  /** The text of one top-level function in `ownership.ts`, from its declaration to the next. */
  const functionBody = (declaration: string): string => {
    const start = ownership.indexOf(declaration);
    expect(start, declaration).toBeGreaterThan(-1);
    const next = ownership.indexOf("\n}\n", start);
    expect(next).toBeGreaterThan(start);
    return ownership.slice(start, next);
  };

  it("index.ts wires the inbox's handover once, as a statement of main(), before either transport branch", () => {
    const call = "  setOwnershipInboxHandover(handOverDocumentInbox);";
    expect(index.split("\n").filter((line) => line === call)).toHaveLength(1);
    expect(index.match(/setOwnershipInboxHandover\(/g)).toHaveLength(1);
    const wired = index.indexOf(call);
    const http = index.indexOf('if (transportMode === "http") {\n    // Ownership');
    const stdio = index.indexOf('setOwnershipTransportMode("stdio");');
    expect(http).toBeGreaterThan(-1);
    expect(stdio).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(http);
    expect(wired).toBeLessThan(stdio);
    expect(index).toMatch(
      /import \{[^}]*\bhandOverDocumentInbox\b[^}]*\} from "\.\/mcp\/awareness\.js";/,
    );
  });

  it("nothing else in src wires the seam or names the inbox's handover", () => {
    expect(filesNaming(/\bsetOwnershipInboxHandover\(/)).toEqual([
      "src/server/index.ts",
      "src/server/sessions/ownership.ts",
    ]);
    expect(ownership.match(/\bsetOwnershipInboxHandover\(/g)).toHaveLength(1);
    // The inbox side: its definition, and `index.ts`'s import and wiring line.
    // (Comments in `ownership.ts` and `inbox-cursor.ts` name it in backticks.)
    expect(filesNaming(/\bhandOverDocumentInbox\b(?!`)/)).toEqual([
      "src/server/index.ts",
      "src/server/mcp/awareness.ts",
    ]);
    expect(index.match(/\bhandOverDocumentInbox\b/g)).toHaveLength(2);
    expect(awareness.match(/\bhandOverDocumentInbox\b(?!`)/g)).toHaveLength(1);
  });

  it("the inbox's handover is synchronous, and reads no flag", () => {
    // A function returning a promise would run outside the ownership module's
    // guard, and a rejection there is an unhandled one.
    expect(awareness).toMatch(
      /^export function handOverDocumentInbox\(documentId: string\): void \{$/m,
    );
    expect(awareness).not.toMatch(/async function handOverDocumentInbox/);
    expect(awareness).not.toMatch(/ownership-flag|ownershipEnabled/);
    const start = awareness.indexOf("export function handOverDocumentInbox(");
    const body = awareness.slice(start, awareness.indexOf("\n}\n", start));
    const keysStart = awareness.indexOf("function currentNoticeKeys(");
    expect(keysStart).toBeGreaterThan(-1);
    const keys = awareness.slice(keysStart, awareness.indexOf("\n}\n", keysStart));
    for (const text of [body, keys]) {
      expect(text).not.toMatch(
        /\bawait\b|\.then\(|withMcp|withInternal|withBrowser|transact\(|Refreshed|refreshAnnotations|getOrCreateDocument/,
      );
    }
    // Nothing in either half writes, pushes, wakes or touches a delivery round
    // (R1.8), on any path: the tab close runs the same functions.
    const handOverFrom = ownership.indexOf("function handOver(documentId: string): void {");
    const handOverBody = ownership.slice(handOverFrom, ownership.indexOf("\n}\n", handOverFrom));
    for (const text of [body, keys, handOverBody]) {
      expect(text).not.toMatch(
        /pushEvent|recordWakeForward|resolveDeliveryRound|recordInboxPoll|startOrWake|broadcast|stampUserChat|getMap\([^)]*\)\s*\.(?:set|delete|clear)\(/,
      );
    }
    // The annotation read is the plain one, on a Y.Doc from the non-creating getter.
    expect(keys).toContain(".listAnnotations()");
    expect(body).toContain("getDocument(documentId)");
  });

  // Amended by the scope PR: a second caller, `undoPassOn`, retires the
  // entries a failed or unclaimed poll created (R1.7). Still awareness.ts only,
  // and each call is inside its named function.
  it("the registry's bulk retire has two callers, the inbox's handover and the poll's undo", () => {
    expect(filesNaming(/\bretireWhere\(/)).toEqual([
      "src/server/mcp/awareness.ts",
      "src/server/mcp/inbox-cursor.ts",
    ]);
    expect(awareness.match(/\bretireWhere\(/g)).toHaveLength(2);
    const start = awareness.indexOf("export function handOverDocumentInbox(");
    const body = awareness.slice(start, awareness.indexOf("\n}\n", start));
    expect(body).toMatch(/deliveryRegistry\.retireWhere\(\s*documentId,/);
    const undoStart = awareness.indexOf("function undoPassOn(");
    expect(undoStart).toBeGreaterThan(-1);
    const undo = awareness.slice(undoStart, awareness.indexOf("\n}\n", undoStart));
    expect(undo).toMatch(
      /deliveryRegistry\.retireWhere\(documentId, \(entry\) => entry\.seq > before\)/,
    );
    // `inbox-cursor.ts`: the definition only.
    const cursor = SRC_FILES.get("src/server/mcp/inbox-cursor.ts") as string;
    expect(cursor.match(/\bretireWhere\(/g)).toHaveLength(1);
  });

  it("the ownership side runs it from exactly two places, each behind its function's first-line flag return, with no await", () => {
    // The definition plus two calls.
    expect(ownership.match(/\bhandOver\(documentId\)/g)).toHaveLength(2);
    expect(ownership.match(/\bhandOver\(/g)).toHaveLength(3);
    expect(ownership.match(/\binboxHandover\(/g)).toHaveLength(1);
    expect(ownership.match(/\binboxHandover\(documentId\)/g)).toHaveLength(1);
    // Private: not exported, and no other file names it.
    expect(ownership).not.toMatch(/export\s+(?:async\s+)?function\s+handOver\b/);
    expect(filesNaming(/\bhandOver\(/)).toEqual(["src/server/sessions/ownership.ts"]);
    for (const declaration of [
      "export function setDocOwner(",
      "export function onDocumentClosed(",
    ]) {
      const body = functionBody(declaration);
      const open = body.indexOf("): void {\n");
      expect(open, declaration).toBeGreaterThan(-1);
      // The first statement of the function is the flag return.
      expect(body.slice(open).startsWith("): void {\n  if (!ownershipEnabled()) return;\n")).toBe(
        true,
      );
      expect(body.match(/\bhandOver\(documentId\)/g), declaration).toHaveLength(1);
      // One synchronous step with the ownership change (R1.6).
      expect(body).not.toMatch(/\bawait\b|\basync\b|\.then\(/);
    }
    const handOver = functionBody("function handOver(documentId: string): void {");
    expect(handOver).toContain("inboxHandover(documentId);");
    expect(handOver).not.toMatch(/\bawait\b|\basync\b|\.then\(/);
    // It runs after the entry is written or deleted, never before.
    const set = functionBody("export function setDocOwner(");
    expect(set.indexOf("ownerByDoc.set(documentId,")).toBeLessThan(
      set.indexOf("handOver(documentId)"),
    );
    expect(set.indexOf("ownerByDoc.delete(documentId)")).toBeLessThan(
      set.indexOf("handOver(documentId)"),
    );
    const closed = functionBody("export function onDocumentClosed(");
    expect(closed.indexOf("ownerByDoc.delete(documentId)")).toBeLessThan(
      closed.indexOf("handOver(documentId)"),
    );
  });

  /**
   * Each line of `ownership.ts` on which the identifier `handoverSeq` is used
   * as the map (not as a property name, such as the snapshot's key), trimmed.
   */
  function handoverSeqUses(): string[] {
    const file = ts.createSourceFile("ownership.ts", ownership, ts.ScriptTarget.Latest, true);
    const lines = ownership.split("\n");
    const uses: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "handoverSeq") {
        const parent = node.parent;
        const isKey =
          (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
          parent.name === node;
        if (!isKey) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          uses.push(lines[line].trim());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return uses;
  }

  it("only a handover writes handoverSeq (and the test setter)", () => {
    expect(ownership.match(/\bhandoverSeq\.set\(/g)).toHaveLength(2);
    expect(functionBody("function handOver(documentId: string): void {")).toContain(
      "handoverSeq.set(documentId, seqSource());",
    );
    expect(functionBody("export function setHandoverSeqForTests(")).toContain("handoverSeq.set(");
    // One reader (the notice-rule PR): a poll scope's `settledThrough`, inside
    // this module, and nothing else in it or anywhere.
    expect(ownership.match(/\bhandoverSeq\.(get|has|forEach|keys|values|entries)\(/g)).toEqual([
      "handoverSeq.get(",
    ]);
    // Every use of the map, by the AST (comments are not identifiers), with
    // the line it sits on (#2420 review, R9.7): a spread, `new Map(...)`, a
    // `.size`, passing it along, or any other read than `settledThrough`'s,
    // the snapshot's spread and the reset's `clear()` adds a line here.
    expect(handoverSeqUses()).toEqual([
      "const handoverSeq = new Map<string, number>();",
      "handoverSeq.set(documentId, seqSource());",
      "settledThrough: (documentId) => handoverSeq.get(documentId) ?? 0,",
      "handoverSeq: [...handoverSeq],",
      "handoverSeq.set(documentId, seq);",
      "handoverSeq.clear();",
    ]);
    expect(ownership).toContain(
      "settledThrough: (documentId) => handoverSeq.get(documentId) ?? 0,",
    );
    expect(filesNaming(/\bhandoverSeq\b/)).toEqual(["src/server/sessions/ownership.ts"]);
  });

  it("a document id holds no colon, so a ledger key's document prefix is exact", () => {
    for (const filePath of [
      "C:\\Users\\me\\notes:draft.md",
      "upload://scratchpad/123e4567-e89b-12d3-a456-426614174000/Scratchpad.md",
      "/home/me/a:b/c:d.md",
      "\\\\server\\share\\x:y.txt",
    ]) {
      expect(docIdFromPath(filePath), filePath).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("no server log line prints a raw session id", () => {
  /**
   * Under the flag every `Mcp-Session-Id` and Claude session id a server log
   * line prints goes through `sessionIdForLog`
   * (ownership design §11.1). This walks every `console.*` call in the files
   * that log them and fails on a template span that interpolates an id-shaped
   * name unwrapped. The exemptions are reviewed: each prints no id.
   */
  const FILES = [
    "src/server/mcp/server.ts",
    "src/server/mcp/transport-registry.ts",
    "src/server/sessions/ownership.ts",
    "src/server/launcher/supervisor.ts",
  ];
  const ID_SHAPED = /(?:^|[^A-Za-z])(?:[a-z]*[sS]essionId|clientId|ownerId|sid|id)\b/;
  const WRAPPED = /^sessionIdForLog\(/;

  it("every id-shaped interpolation in a console call is wrapped", () => {
    const naked: string[] = [];
    let spans = 0;
    for (const file of FILES) {
      const text = SRC_FILES.get(file) as string;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, inConsole: boolean): void => {
        const isConsole =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "console";
        const inside = inConsole || isConsole;
        if (inside && ts.isTemplateSpan(node)) {
          spans++;
          const expr = node.expression.getText(sf);
          // A span holding a nested template is judged by the nested spans,
          // which this walk visits on its own.
          let nested = false;
          node.expression.forEachChild(function find(n): void {
            if (ts.isTemplateExpression(n)) nested = true;
            else n.forEachChild(find);
          });
          if (!nested && ID_SHAPED.test(expr) && !WRAPPED.test(expr)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            naked.push(`${file}:${line + 1} \${${expr}}`);
          }
        }
        ts.forEachChild(node, (child) => visit(child, inside));
      };
      visit(sf, false);
    }
    expect(spans).toBeGreaterThan(20);
    expect(naked).toEqual([]);
  });
});

describe("the identity headers stay out of CORS (ownership design §11.1)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await closeMcpSession();
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  });

  it("/api allows only Content-Type as a request header, and /mcp grants no origin", async () => {
    const port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const api = await fetch(`${base}/api/open`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-tandem-client-id, x-claude-session-id",
      },
    });
    await api.text();
    expect(api.headers.get("access-control-allow-headers")).toBe("Content-Type");
    const mcp = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-tandem-client-id",
      },
    });
    await mcp.text();
    expect(mcp.headers.get("access-control-allow-origin")).toBeNull();
    expect(mcp.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe("an ownerId is never published (ADR-054; OwnerRecord.ownerId)", () => {
  // An ownerId carries a raw header value (an `Mcp-Session-Id` is a bearer
  // value for its transport), so whatever a person or another session sees
  // names the record by its label. The files that may mention `ownerId` at all
  // are the identity plumbing; a new one (PR 5's `broadcastOpenDocs`, a
  // diagnostics route) joins this list only after review shows it publishes
  // the label instead.
  it("only the identity plumbing mentions ownerId in src", () => {
    const files = [...SRC_FILES]
      .filter(([f]) => /\.(ts|svelte)$/.test(f))
      .filter(([, src]) => /\bownerId\b/.test(src))
      .map(([f]) => f)
      .sort();
    // `owned-op.ts` (PR 1c) is the one tool-side file that reads
    // `caller.ownerId`; every refusal it builds carries the holder's label and
    // display kind (`ownership-enforcement.test.ts` checks each envelope).
    expect(files).toEqual([
      "src/server/mcp/owned-op.ts",
      "src/server/mcp/response.ts",
      "src/server/mcp/server.ts",
      "src/server/mcp/transport-registry.ts",
      "src/server/sessions/caller.ts",
      "src/server/sessions/context.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });
});

describe("the inbox's door into ownership (the scope PR)", () => {
  const filesNaming = (pattern: RegExp) =>
    [...SRC_FILES]
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file)
      .sort();

  it("the stuck-write release's clock is read only by the ownership module", () => {
    // Recorded in the queue, read only in `ownership.ts` (the brief's amendment 3).
    expect(filesNaming(/\bdocOpBusySince\b/)).toEqual([
      "src/server/sessions/doc-op-queue.ts",
      "src/server/sessions/ownership.ts",
    ]);
    expect(filesNaming(/\bdocOpWaitLimitMs\b/)).toEqual([
      "src/server/sessions/doc-op-queue.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });

  it("only the inbox handler reaches the poll scope and its claim", () => {
    // Any other importer would get a claim path that bypasses the inbox
    // commit's rules (claims only after validation and the ledger commits).
    expect(filesNaming(/\binboxOwnership\b/)).toEqual([
      "src/server/mcp/awareness.ts",
      "src/server/sessions/ownership.ts",
    ]);
    for (const hook of [/\bsetInboxClaimCheckForTests\b/, /\bsetInboxScopeReadForTests\b/]) {
      expect(filesNaming(hook)).toEqual(["src/server/sessions/ownership.ts"]);
    }
    expect(filesNaming(/\bsetInboxResponseCorruptorForTests\b/)).toEqual([
      "src/server/mcp/awareness.ts",
    ]);
    expect(filesNaming(/"poll-claim"/)).toEqual(["src/server/sessions/ownership.ts"]);
  });
});
