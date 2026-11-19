import type { Server } from "node:http";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

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

describe("the delivery-round seam is wired in a running server (the delivery-rounds PR)", () => {
  // Unwired, rounds stay master's one global round even flag on, and no unit
  // test would notice: `main()` cannot run in a unit test, so the call is
  // pinned from source, beside `setOwnershipSeqSource`.
  const src = SRC_FILES.get("src/server/index.ts") as string;

  it("index.ts wires the ownership side's keyedDeliveryRounds and the registry, once, before either transport branch", () => {
    const call =
      "setDeliveryRoundSeam({\n    keyed: keyedDeliveryRounds,\n    isDocumentOpen: (documentId) => getOpenDocs().has(documentId),\n  });";
    expect(src.split(call)).toHaveLength(2);
    const wired = src.indexOf(call);
    expect(wired).toBeGreaterThan(
      src.indexOf("setOwnershipSeqSource(() => deliveryRegistry.counter);"),
    );
    expect(wired).toBeLessThan(src.indexOf('if (transportMode === "http") {\n    // Ownership'));
    const callers = [...SRC_FILES]
      .filter(([, text]) => /\bsetDeliveryRoundSeam\(/.test(text))
      .map(([file]) => file)
      .sort();
    expect(callers).toEqual(["src/server/events/delivery-state.ts", "src/server/index.ts"]);
    const ownership = SRC_FILES.get("src/server/sessions/ownership.ts") as string;
    expect(ownership).toMatch(
      /export function keyedDeliveryRounds\(\): boolean \{\n {2}return ownershipEnabled\(\);\n\}/,
    );
  });

  it("exactly one call in index.ts, an unconditional statement of main() in the same block as setOwnershipSeqSource (review round 1)", () => {
    // Every use of the name, whatever its form: a second call (say
    // `setDeliveryRoundSeam(undefined)`) would unwire the first, and so would
    // an alias (`const f = setDeliveryRoundSeam; f(undefined)`) or a `.call`
    // (`setDeliveryRoundSeam.call(null, undefined)`), which a count of
    // `setDeliveryRoundSeam(` cannot see (the keyed-rounds suites PR, R2). So
    // the identifier itself is counted, over index.ts's parsed syntax tree:
    // comments are not in it (a mention in a comment neither adds one nor
    // hides one), and neither is text inside a string. Exactly two, and each
    // in its role: the import specifier, unrenamed, from the delivery-state
    // module (so another function imported under this name is refused), and
    // the call, a statement of the same block as `setOwnershipSeqSource`'s
    // (so a call commented out, with a stray reference to keep the count,
    // is refused). Between those two statements, no `return` or `throw` at
    // any depth outside a nested function.
    //
    // What this pin of source cannot see (limits accepted by Bryan on
    // 2026-11-17, D-own-6, recorded in ADR-054: the pin guards against an
    // accidental second writer, and a deliberate bypass is a review matter):
    // an exit earlier in `main()`, before `setOwnershipSeqSource`; between the
    // two statements, a conditional exit that is not a `return` or `throw`
    // statement (a call that throws, say); braces or comment markers inside
    // strings, which the text depth check below counts as code; a call
    // through a namespace import by element access
    // (`ns["setDeliveryRoundSeam"]`, or a computed name such as
    // `ns["set" + name]`); and calls from other `src` files through an alias
    // or `.call` (the callers check above matches `setDeliveryRoundSeam(`
    // only). A behavioural pin that boots `main()` would see each of them.
    const tree = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true);
    const uses: ts.Identifier[] = [];
    let seqStatement: ts.Statement | undefined;
    const visit = (node: ts.Node): void => {
      // `forEachChild`, never `getChildren`: the latter walks JSDoc too.
      if (ts.isIdentifier(node) && node.text === "setDeliveryRoundSeam") uses.push(node);
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "setOwnershipSeqSource"
      ) {
        seqStatement = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(uses).toHaveLength(2);
    const [imported, called] = uses as [ts.Identifier, ts.Identifier];
    const specifier = imported.parent;
    expect(ts.isImportSpecifier(specifier) && specifier.propertyName === undefined).toBe(true);
    const declaration = specifier.parent.parent.parent;
    expect(
      ts.isImportDeclaration(declaration) &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        declaration.moduleSpecifier.text,
    ).toBe("./events/delivery-state.js");
    const call = called.parent;
    expect(ts.isCallExpression(call) && call.expression === called).toBe(true);
    const callStatement = call.parent;
    expect(ts.isExpressionStatement(callStatement)).toBe(true);
    expect(seqStatement, "setOwnershipSeqSource's statement").toBeDefined();
    const block = (seqStatement as ts.Statement).parent;
    expect(callStatement.parent).toBe(block);
    const statements = (block as ts.Block).statements;
    const seqAt = statements.indexOf(seqStatement as ts.Statement);
    const callAt = statements.indexOf(callStatement as ts.Statement);
    expect(seqAt).toBeGreaterThan(-1);
    expect(seqAt).toBeLessThan(callAt);
    const exits: string[] = [];
    const findExits = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) exits.push(node.getText());
      ts.forEachChild(node, findExits);
    };
    for (const statement of statements.slice(seqAt + 1, callAt)) findExits(statement);
    expect(exits).toEqual([]);
    const lines = src.split("\n");
    // The call's own line, from the syntax tree, so a comment mentioning the
    // call above it is not taken for it.
    const at = tree.getLineAndCharacterOfPosition(called.getStart(tree)).line;
    // Two spaces and nothing before the call: not wrapped in a condition on
    // its own line.
    expect(lines[at]).toBe("  setDeliveryRoundSeam({");
    // Between `setOwnershipSeqSource` (pinned as a statement of main()) and
    // this call every brace closes, so the call is in the same block, not
    // inside a branch or a function opened between them.
    const from = lines.findIndex((l) => l.includes("setOwnershipSeqSource(() =>"));
    expect(from).toBeGreaterThan(-1);
    expect(from).toBeLessThan(at);
    const between = lines
      .slice(from, at)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    let depth = 0;
    for (const ch of between) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("the seam has one writer: setDeliveryRoundSeam itself, which its own module never calls (the keyed-rounds suites PR)", () => {
    // A second assignment inside delivery-state.ts, or a call of the setter
    // there (the callers check above exempts this file, whose definition
    // matches it), would unwire the seam with every pin on index.ts still
    // passing. So the setter's name is counted over this module's syntax tree,
    // as `setOwnershipSeqSource`'s is in its own: exactly one identifier, the
    // declaration's (no call, alias or `.call`). A text pin for the
    // assignment: it does not see a compound (`??=`), destructuring or
    // parenthesised (`(roundSeam) = x`) assignment, or a mutation of the seam
    // object (`roundSeam.keyed = ...`) (limits accepted by Bryan on 2026-11-17,
    // D-own-6, recorded in ADR-054).
    const module = SRC_FILES.get("src/server/events/delivery-state.ts") as string;
    const tree = ts.createSourceFile("delivery-state.ts", module, ts.ScriptTarget.Latest, true);
    const named: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "setDeliveryRoundSeam") named.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(named).toHaveLength(1);
    expect(ts.isFunctionDeclaration((named[0] as ts.Identifier).parent)).toBe(true);
    expect(module.match(/\broundSeam\s*=(?!=)/g)).toHaveLength(1);
    expect(module).toMatch(
      /export function setDeliveryRoundSeam\(seam: DeliveryRoundSeam \| undefined\): void \{\n {2}roundSeam = seam;\n\}/,
    );
  });

  it("no src file imports a round seam, drop or close under another name", () => {
    for (const [file, text] of SRC_FILES) {
      expect(text, file).not.toMatch(
        /\b(?:setDeliveryRoundSeam|dropDocumentDeliveryRound|dropMessageDeliveryRounds|closeMessageDeliveryRound)\s+as\s+\w/,
      );
    }
  });

  it("the drops sit where the brief puts them: the close in closeDocumentById, Clear chat in clearCtrlChatDurably, never the chat observer", () => {
    const callersOf = (name: string) =>
      [...SRC_FILES]
        .filter(
          ([file, text]) =>
            file !== "src/server/events/delivery-state.ts" && text.includes(`${name}(`),
        )
        .map(([file]) => file)
        .sort();
    expect(callersOf("dropDocumentDeliveryRound")).toEqual(["src/server/mcp/document-service.ts"]);
    expect(callersOf("dropMessageDeliveryRounds")).toEqual(["src/server/session/manager.ts"]);
    expect(callersOf("closeMessageDeliveryRound")).toEqual([
      "src/server/mcp/awareness.ts",
      "src/server/mcp/channel-routes.ts",
    ]);
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
        /pushEvent|recordWakeForward|resolveDeliveryRound|recordInboxPoll|startOrWake|broadcast|stampUserChat|dropDocumentDeliveryRound|dropMessageDeliveryRounds|closeMessageDeliveryRound|getMap\([^)]*\)\s*\.(?:set|delete|clear)\(/,
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
        // PR 3a: the owner handle header is not granted either.
        "Access-Control-Request-Headers":
          "x-tandem-client-id, x-claude-session-id, x-tandem-owner-handle",
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

describe("the chat side's seams are wired in a running server (the chat owners PR, R2.2)", () => {
  // Each is a seam that answers "nothing" when unwired (no message handled,
  // none on any document, no row, a re-owe that writes nothing, a delete
  // that tells nobody), so every unit test passes without the wiring.
  // `main()` cannot be run in a unit test, so the calls are pinned from
  // source, as the two above are. `ownership-chat.test.ts` wires the same
  // expressions against the real inbox and calls each member.
  const index = SRC_FILES.get("src/server/index.ts") as string;
  const filesNaming = (pattern: RegExp) =>
    [...SRC_FILES]
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file)
      .sort();
  const beforeBothBranches = (line: string) => {
    expect(index.split("\n").filter((l) => l === line)).toHaveLength(1);
    const wired = index.indexOf(line);
    const http = index.indexOf('if (transportMode === "http") {\n    // Ownership');
    const stdio = index.indexOf('setOwnershipTransportMode("stdio");');
    expect(http).toBeGreaterThan(-1);
    expect(stdio).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(http);
    expect(wired).toBeLessThan(stdio);
  };

  it("index.ts wires the chat side once, as a statement of main(), before either transport branch", () => {
    beforeBothBranches("  setOwnershipChatSide(ownershipChatSide);");
    expect(index.match(/setOwnershipChatSide\(/g)).toHaveLength(1);
    expect(filesNaming(/\bsetOwnershipChatSide\(/)).toEqual([
      "src/server/index.ts",
      "src/server/sessions/ownership.ts",
    ]);
    // (A comment in `ownership.ts` names it in backticks.)
    expect(filesNaming(/\bownershipChatSide\b(?!`)/)).toEqual([
      "src/server/index.ts",
      "src/server/mcp/awareness.ts",
    ]);
  });

  it("the chat side's members are synchronous, and its file reads no flag", () => {
    const awareness = SRC_FILES.get("src/server/mcp/awareness.ts") as string;
    const start = awareness.indexOf("export const ownershipChatSide = Object.freeze({");
    expect(start).toBeGreaterThan(-1);
    const body = awareness.slice(start, awareness.indexOf("\n});\n", start));
    for (const member of [
      "handledKeys()",
      "messagesOn(documentId: string)",
      "message(key: string)",
      "reOwe(keys: readonly string[])",
      "owedToFreshReader()",
    ]) {
      expect(body, member).toContain(member);
    }
    expect(body).not.toMatch(/\basync\b|\bawait\b|\.then\(/);
    const reOwe = awareness.slice(
      awareness.indexOf("function reOweChat("),
      awareness.indexOf("\n}\n", awareness.indexOf("function reOweChat(")),
    );
    expect(reOwe).not.toMatch(/\basync\b|\bawait\b|\.then\(/);
    // One server-origin transaction (Critical Rule 2), and no push.
    expect(reOwe.match(/withInternal\(/g)).toHaveLength(1);
    expect(reOwe).not.toMatch(/withMcp|withBrowser|transact\(|pushEvent/);
    expect(awareness).not.toMatch(/ownership-flag|ownershipEnabled/);
  });

  it("index.ts wires the deletion listener once, as a statement of main(), before either transport branch", () => {
    beforeBothBranches("  setChatRowsDeletedListener(forgetChatMessageOwners);");
    expect(filesNaming(/\bsetChatRowsDeletedListener\(/)).toEqual([
      "src/server/chat-row-deletions.ts",
      "src/server/index.ts",
    ]);
    expect(filesNaming(/\bforgetChatMessageOwners\b/)).toEqual([
      "src/server/index.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });

  it("index.ts wires the client-write undo once, before either transport branch and before Hocuspocus starts (the posts PR, R4.5; security review L2)", () => {
    beforeBothBranches("  setChatClientWritesUndone(undoClientChatWrites);");
    const wired = index.indexOf("  setChatClientWritesUndone(undoClientChatWrites);");
    expect(wired).toBeLessThan(index.indexOf("startHocuspocus(wsPort)"));
    expect(filesNaming(/\bsetChatClientWritesUndone\(/)).toEqual([
      "src/server/chat-client-writes.ts",
      "src/server/index.ts",
    ]);
    // (The seam's docblock names it.)
    expect(filesNaming(/\bundoClientChatWrites\b/)).toEqual([
      "src/server/chat-client-writes.ts",
      "src/server/index.ts",
      "src/server/mcp/document-service.ts",
      "src/server/sessions/ownership.ts",
    ]);
    // The seam imports nothing; the observer and the undo never name the
    // ownership module or the flag.
    const seam = SRC_FILES.get("src/server/chat-client-writes.ts") as string;
    expect(seam).not.toMatch(/^import /m);
    for (const file of [
      "src/server/events/observers/ctrl-chat.ts",
      "src/server/events/observers/chat-client-undo.ts",
    ]) {
      expect(SRC_FILES.get(file)).not.toMatch(/["'`][^"'`]*\/ownership(\.js)?["'`]|ownership-flag/);
    }
  });

  it("the carried-over capture and the pending drop run after restoreCtrlDoc, inside restoreCtrlSession (review round 1, item 1)", () => {
    const service = SRC_FILES.get("src/server/mcp/document-service.ts") as string;
    const fn = service.slice(
      service.indexOf("export async function restoreCtrlSession("),
      service.indexOf("\n}\n", service.indexOf("export async function restoreCtrlSession(")),
    );
    const restored = fn.indexOf("restoreCtrlDoc(ctrlDoc, saved);");
    expect(restored).toBeGreaterThan(-1);
    expect(fn.indexOf("captureCarriedOverChat(")).toBeGreaterThan(restored);
    expect(fn.indexOf("dropPendingUpdates(ctrlDoc)")).toBeGreaterThan(restored);
    expect(service.match(/captureCarriedOverChat\(/g)).toHaveLength(1);
  });

  it("each chat-side delete path tells the seam, and neither imports the ownership module", () => {
    const observer = SRC_FILES.get("src/server/events/observers/ctrl-chat.ts") as string;
    const manager = SRC_FILES.get("src/server/session/manager.ts") as string;
    expect(observer).toContain("noteChatRowsDeleted(deleted);");
    // Before the origin skip, so every origin's delete is told.
    expect(observer.indexOf("noteChatRowsDeleted(deleted);")).toBeLessThan(
      observer.indexOf("if (shouldSkipChannel(txn.origin)) return;"),
    );
    const clear = manager.slice(
      manager.indexOf("export async function clearCtrlChatDurably("),
      manager.indexOf("\n}\n", manager.indexOf("export async function clearCtrlChatDurably(")),
    );
    expect(clear).toContain("noteChatRowsDeleted(capturedIds);");
    expect(filesNaming(/\bnoteChatRowsDeleted\(/)).toEqual([
      "src/server/chat-row-deletions.ts",
      "src/server/events/observers/ctrl-chat.ts",
      "src/server/session/manager.ts",
    ]);
    for (const text of [observer, manager]) {
      // Any specifier naming the ownership module or the flag, with or without
      // an extension or the `sessions/` prefix.
      expect(text).not.toMatch(/["'][^"']*\/ownership(\.js)?["']|ownership-flag/);
    }
    // The delete arm fills the list it hands the seam.
    const arm = observer.slice(
      observer.indexOf("const deleted: string[] = [];"),
      observer.indexOf("noteChatRowsDeleted(deleted);"),
    );
    expect(arm).toMatch(/change\.action === "delete"[\s\S]*deleted\.push\(key\)/);
    const seam = SRC_FILES.get("src/server/chat-row-deletions.ts") as string;
    expect(seam).not.toMatch(/^import /m);
  });

  it("the reply's claim is a named unqueued change, and only the ownership module names its cause", () => {
    expect(filesNaming(/"reply-claim"/)).toEqual(["src/server/sessions/ownership.ts"]);
    const queue = SRC_FILES.get("src/server/sessions/doc-op-queue.ts") as string;
    expect(queue).toContain("a claim made by an accepted `tandem_reply`");
  });

  it("a post's claim is a named unqueued change too, and only the ownership module names its cause (review round 1, item 13)", () => {
    expect(filesNaming(/"post-claim"/)).toEqual(["src/server/sessions/ownership.ts"]);
    const queue = SRC_FILES.get("src/server/sessions/doc-op-queue.ts") as string;
    expect(queue).toContain("a claim made by an accepted chat post");
    expect(queue).toContain("cause\n * `post-claim`");
    expect(queue).toContain("Seven run where they are");
  });
});

describe("Tandem's Claude's presence has one writer per field (#2358 PR 3b-1, R2.9)", () => {
  /**
   * Presence (R2.1) is recomputed only when a field it reads is written
   * through its setter, which marks presence dirty. A raw write anywhere else
   * (`lastError = "spawn-failed"` in a new path, say) passes every behavioural
   * case that does not reach that path, and leaves presence stale there. So
   * every assignment to each field — plain, compound, `++`/`--`, destructuring
   * or parenthesised — is found over `supervisor.ts`'s syntax tree, and must
   * sit inside that field's setter. The one named exception (Ruling H) is
   * `status()`'s `cli-unusable` clear, exactly one `lastError = undefined`
   * there.
   *
   * What this pin cannot see (review round 1, item 7): a write as the head of
   * a `for (x of …)` or `for (x in …)` loop; a setter that calls
   * `markPresenceDirty` only conditionally (the check below is that the call
   * appears in the setter's body, not that it always runs); and a raw write
   * inside a nested function within the field's own setter, which is counted
   * as the setter's. Each is a review matter: none is a shape this file uses.
   */
  const SETTERS: Record<string, string> = {
    lastError: "setLastError",
    breakerTripped: "setBreakerTripped",
    configured: "setConfigured",
    restartTimer: "setRestartTimer",
    launching: "setLaunching",
    lastRunBound: "setLastRunBound",
    standby: "setStandby",
  };

  function writesOutsideSetters(text: string): string[] {
    const sf = ts.createSourceFile("supervisor.ts", text, ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const enclosingFunction = (node: ts.Node): string | undefined => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
      }
      return undefined;
    };
    /** Identifiers a write targets: `x`, `(x)`, `[x] = …`, `({ x } = …)`. */
    const targets = (node: ts.Expression): ts.Identifier[] => {
      if (ts.isParenthesizedExpression(node)) return targets(node.expression);
      if (ts.isIdentifier(node)) return [node];
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : targets(e)));
      }
      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.flatMap((p) =>
          ts.isShorthandPropertyAssignment(p)
            ? [p.name]
            : ts.isPropertyAssignment(p)
              ? targets(p.initializer)
              : [],
        );
      }
      return [];
    };
    const record = (id: ts.Identifier) => {
      const setter = SETTERS[id.text];
      if (setter === undefined) return;
      const fn = enclosingFunction(id);
      if (fn === setter) return;
      const line = sf.getLineAndCharacterOfPosition(id.getStart()).line + 1;
      out.push(`${id.text} written in ${fn ?? "(top level)"} at line ${line}`);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        for (const id of targets(node.left)) record(id);
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        for (const id of targets(node.operand)) record(id);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  it("each field is assigned only inside its setter, but for status()'s one cli-unusable clear", () => {
    const text = SRC_FILES.get("src/server/launcher/supervisor.ts") as string;
    expect(writesOutsideSetters(text)).toEqual([
      "lastError written in status at line " + statusClearLine(text),
    ]);
    // Every setter exists and marks presence dirty.
    for (const setter of Object.values(SETTERS)) {
      const at = text.indexOf(`function ${setter}(`);
      expect(at, setter).toBeGreaterThan(-1);
      const body = text.slice(at, text.indexOf("\n  }\n", at));
      expect(body, setter).toContain("markPresenceDirty();");
    }
  });

  it("the pin is not vacuous: a planted raw write outside a setter is found", () => {
    const text = SRC_FILES.get("src/server/launcher/supervisor.ts") as string;
    const planted = text.replace(
      "function recordStartThrow(err: unknown, label: string): void {\n",
      'function recordStartThrow(err: unknown, label: string): void {\n    lastError = "spawn-failed";\n    [breakerTripped] = [true];\n    (launching)++;\n',
    );
    expect(planted).not.toBe(text);
    const found = writesOutsideSetters(planted).filter((w) => w.includes("recordStartThrow"));
    expect(found.map((w) => w.split(" ")[0]).sort()).toEqual([
      "breakerTripped",
      "lastError",
      "launching",
    ]);
  });

  function statusClearLine(text: string): number {
    const at = text.indexOf('lastError === "cli-unusable" &&');
    const clear = text.indexOf("lastError = undefined;", at);
    return text.slice(0, clear).split("\n").length;
  }

  // Matches any of the three pending-state terms the pin below keeps out of
  // `recomputePresence`.
  const PENDING_STATE_TERMS = /messageStartQueued|passesQueued|restartPending\(/;

  it("R2.1 (v) and Ruling A: a restart underway is exactly restartTimer or launching, never messageStartQueued or restartPending()", () => {
    // Not reachable at the exact moment through the public API (a message
    // start's queued flag outlives `launching` by a microtask), so pinned here:
    // presence's (v) reads these three fields and nothing else.
    const text = SRC_FILES.get("src/server/launcher/supervisor.ts") as string;
    const fn = text.slice(text.indexOf("function recomputePresence("));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body).toMatch(
      /const noError = lastError === undefined \|\| restartTimer !== null \|\| launching > 0;/,
    );
    // Nor a start pass in flight (3b-2b1a): a start-or-wake-only pass is not a
    // restart under way.
    expect(body).not.toMatch(PENDING_STATE_TERMS);
  });

  it("the pending-state pin is not vacuous: each term is declared under its name, and a planted read is found (3b-2b1b-R0, R0.1)", () => {
    const text = SRC_FILES.get("src/server/launcher/supervisor.ts") as string;
    // The positive anchor: a rename of any of the three in supervisor.ts fails
    // here rather than leaving the negative match above passing vacuously. On
    // the comment-stripped source, so a comment quoting a declaration cannot
    // stand in for it after a rename.
    const code = stripComments(text);
    expect(code).toContain("let passesQueued = 0;");
    expect(code).toContain("let messageStartQueued = false;");
    expect(code).toContain("function restartPending(");
    // And the regex finds each term once it is read in the body.
    const fn = text.slice(text.indexOf("function recomputePresence("));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    const anchor = "const noError = lastError === undefined";
    expect(body).toContain(anchor);
    for (const read of [
      "if (messageStartQueued) return;",
      "if (passesQueued > 0) return;",
      "if (restartPending()) return;",
    ]) {
      const planted = body.replace(anchor, `${read}\n    ${anchor}`);
      expect(planted, read).not.toBe(body);
      expect(planted, read).toMatch(PENDING_STATE_TERMS);
    }
  });

  it("the seam's diagnosticsForTests is read by no src file but its definition (review round 1, item 9)", () => {
    const readers = [...SRC_FILES.entries()]
      .filter(([, text]) => text.includes("diagnosticsForTests"))
      .map(([file, text]) => [file, text.match(/diagnosticsForTests/g)?.length ?? 0] as const);
    // Declared on `TandemPresenceSeam` and defined on the seam object: two
    // mentions, both in supervisor.ts. A route, tool or log line reading it
    // would add a mention here or a file below.
    expect(readers).toEqual([["src/server/launcher/supervisor.ts", 2]]);
  });

  it("R2.8's order: noteOwnerHandleBind records the transport's bind synchronously after confirmBind", () => {
    // The run start is a microtask queued in `onFirstBind`, which `confirmBind`
    // calls; it sees the transport as bound only because nothing awaits between
    // `confirmBind` and `entry.boundSpawn = …` (behavioural cover:
    // owner-handle-chain.test.ts, the R2.8 case).
    const server = SRC_FILES.get("src/server/mcp/server.ts") as string;
    expect(server).toMatch(
      /confirmBind\(candidate, sessionId\)\) \{\n {4}entry\.boundSpawn = candidate\.serial;/,
    );
    const fn = server.slice(server.indexOf("function noteOwnerHandleBind("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/\bawait\b/);
  });
});

describe("the supervisor's start-or-wake and requestWake are called by nothing yet (#2358 PR 3b-2a, R2.8)", () => {
  // 3b-2b deletes this describe in the PR that wires them. Token-level, not a
  // call regex: a `.startOrWake(` regex misses an optional call (`?.`), a
  // reference passed on without being called, bracket access and a
  // destructuring (including in a parameter), all of which name the token.
  const SUPERVISOR = "src/server/launcher/supervisor.ts";
  const OWNERSHIP = "src/server/sessions/ownership.ts";

  it("no src file but the supervisor names requestWake or the waiting decision", () => {
    expect(filesMentioning("requestWake", [SUPERVISOR])).toEqual([]);
    // Covers `index.ts`'s `createSupervisor` options however they are built
    // (a literal, an object built first, a spread).
    expect(filesMentioning("workWaiting", [SUPERVISOR])).toEqual([]);
  });

  it("startOrWake outside the supervisor is only ownership.ts's own function: its definition and two bare calls", () => {
    expect(filesMentioning("startOrWake", [SUPERVISOR])).toEqual([OWNERSHIP]);
    const text = stripComments(SRC_FILES.get(OWNERSHIP) as string);
    const sites = [...text.matchAll(/\bstartOrWake\b/g)].map((m) => {
      const before = text.slice(0, m.index).trimEnd();
      return {
        prev: before.slice(-1),
        next: text.slice(m.index + "startOrWake".length).slice(0, 1),
      };
    });
    // Every site is a bare call or the definition: followed by `(` (so never
    // a destructured name or a reference passed on) and not preceded by `.`
    // or `[` (so never a member or bracket access, `?.` included).
    expect(sites).toHaveLength(3);
    for (const site of sites) {
      expect(site.next).toBe("(");
      expect([".", "["]).not.toContain(site.prev);
    }
    expect(text).toMatch(/export function startOrWake\(cause: WakeCause\): void \{/);
    expect(text).toMatch(/\bstartOrWake\("message-owner"\);/);
    expect(text).toMatch(/\bstartOrWake\(cause\);/);
  });
});

describe("waiting on a document (#2358 PR 3b-2b1b)", () => {
  const MODULE = "src/server/mcp/inbox-selection.ts";
  const index = SRC_FILES.get("src/server/index.ts") as string;
  // Re-declared from the chat-side describe above (local there), not lifted,
  // so that describe stays as it was.
  const beforeBothBranches = (line: string) => {
    expect(index.split("\n").filter((l) => l === line)).toHaveLength(1);
    const wired = index.indexOf(line);
    const http = index.indexOf('if (transportMode === "http") {\n    // Ownership');
    const stdio = index.indexOf('setOwnershipTransportMode("stdio");');
    expect(http).toBeGreaterThan(-1);
    expect(stdio).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(http);
    expect(wired).toBeLessThan(stdio);
  };

  it("the module's imports are exactly R1.2's list (type-only statements marked)", () => {
    const text = SRC_FILES.get(MODULE) as string;
    // Whitespace folded, and a wrapped list's trailing comma dropped (biome
    // wraps the 3b-2b1b-chat schema import).
    const statements = [...text.matchAll(/^import\b[^;]*;/gm)].map((m) =>
      m[0].replace(/\s+/g, " ").replace(/\{ (.*?), \}/, "{ $1 }"),
    );
    expect(statements).toEqual([
      'import type { Annotation, AnnotationReply, ChatMessage } from "../../shared/types.js";',
      // #2460: `replyPrivacyAllows` joins deliberately (the shared privacy predicate).
      'import { isClaudeFacing, replyPrivacyAllows } from "../annotations/projection.js";',
      'import type { ModeState } from "../mode.js";',
      'import { inboxChatMessageSchema, inboxUserReplySchema, userActionSchema } from "./output-schemas.js";',
    ]);
    // Nothing reaches another module any other way (dynamic import, require).
    expect(stripComments(text)).not.toMatch(/\bimport\(|\brequire\(|^export\b[^;]*\bfrom\b/m);
  });

  it("only index.ts installs the probe and names documentWaiting, once, as a statement of main() before either transport branch", () => {
    expect(filesMentioning("setWaitingProbe", ["src/server/sessions/ownership.ts"])).toEqual([
      "src/server/index.ts",
    ]);
    expect(filesMentioning("documentWaiting", ["src/server/mcp/awareness.ts"])).toEqual([
      "src/server/index.ts",
    ]);
    beforeBothBranches("  setWaitingProbe(documentWaiting);");
    expect(stripComments(index).match(/\bsetWaitingProbe\b/g)).toHaveLength(2);
    // Inside the ownership module: the declaration, the setter and the test
    // reset are its only writes of the probe, and nothing in it calls the setter.
    const ownership = stripComments(SRC_FILES.get("src/server/sessions/ownership.ts") as string);
    expect(ownership).toContain(
      "let waitingProbe: (documentId: string, ownerId: string) => boolean = () => false;",
    );
    expect(ownership.match(/\bwaitingProbe\s*=(?!=)/g)).toHaveLength(2);
    expect(ownership.match(/\bsetWaitingProbe\b/g)).toHaveLength(1);
  });
});

describe("waiting, the chat half and the decision (#2358 PR 3b-2b1b-chat)", () => {
  const OWNERSHIP = "src/server/sessions/ownership.ts";

  it("tandemWorkWaiting is named by no src file but ownership.ts (3b-2b1c changes this pin)", () => {
    expect(filesMentioning("tandemWorkWaiting", [OWNERSHIP])).toEqual([]);
    // The positive anchor: the scan sees the definition.
    expect(filesMentioning("tandemWorkWaiting")).toEqual([OWNERSHIP]);
  });

  it("the pure chat rule is reached from awareness.ts only", () => {
    expect(
      filesMentioning("chatRowsOwedToFreshReader", ["src/server/mcp/inbox-selection.ts"]),
    ).toEqual(["src/server/mcp/awareness.ts"]);
  });

  it("the chat side's new member is named by awareness.ts (its body) and ownership.ts (its one reader) only", () => {
    expect(filesMentioning("owedToFreshReader")).toEqual([
      "src/server/mcp/awareness.ts",
      OWNERSHIP,
    ]);
  });

  it("computed, not consumed, inside ownership.ts too: tandemWorkWaiting is only defined, tandemChatWaiting defined and called twice (by tandemWorkWaiting and the step-5 composite) (review round 1, R1.3; 3b-2b1b-chat-step5)", () => {
    // The per-file pin above cannot see a caller inside ownership.ts, where
    // step 5 and startOrWake live. 3b-2b1c changes these counts.
    const text = stripComments(SRC_FILES.get(OWNERSHIP) as string);
    expect(text.match(/\btandemWorkWaiting\b/g)).toHaveLength(1);
    expect(text).toContain("export function tandemWorkWaiting(): boolean {");
    expect(text.match(/\btandemChatWaiting\b/g)).toHaveLength(3);
    expect(text).toContain("function tandemChatWaiting(");
    expect(text).toContain("tandemChatWaiting(() => true)");
  });

  it("step 5 asks the composite, once, in its condition; the composite asks the probe first and the chat that follows the document (3b-2b1b-chat-step5)", () => {
    const text = stripComments(SRC_FILES.get(OWNERSHIP) as string);
    // Defined once and called once.
    expect(text.match(/\bwaitingAtDocumentChange\b/g)).toHaveLength(2);
    const setDocOwner = text.slice(
      text.indexOf("export function setDocOwner("),
      text.indexOf("function reOweDocumentChat("),
    );
    expect(text.indexOf("export function setDocOwner(")).toBeGreaterThanOrEqual(0);
    expect(setDocOwner).toMatch(
      /cause !== "take-back" &&\s*waitingAtDocumentChange\(documentId, next\.ownerId\)\s*\)\s*\{\s*startOrWake\(cause\);/,
    );
    expect(setDocOwner).not.toContain("waitingProbe(");
    // The re-owe precedes step 5.
    expect(setDocOwner.indexOf("reOweDocumentChat(documentId)")).toBeGreaterThanOrEqual(0);
    expect(setDocOwner.indexOf("reOweDocumentChat(documentId)")).toBeLessThan(
      setDocOwner.indexOf("waitingAtDocumentChange("),
    );
    const start = text.indexOf("function waitingAtDocumentChange(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = text.slice(start, text.indexOf("\n}\n", start));
    expect(body).toContain("if (waitingProbe(documentId, ownerId)) return true;");
    expect(body).toContain("if (ownerId !== TANDEM_OWNER_ID) return false;");
    expect(body).toContain("facts.documentId === documentId");
    expect(body).toContain("standing.perMessage === false");
    expect(body).toContain('logLimited("waiting-step5-chat", STEP5_CHAT_FAILED)');
    expect(body.indexOf("waitingProbe(")).toBeLessThan(body.indexOf("try {"));
  });

  it("the waiting rule builds the chat item from exactly admitChatItem's fields (review round 1, R1.2)", () => {
    // Each literal, comment-stripped and whitespace-folded: `admitChatItem`'s
    // `const item = { ... };` and `chatItemAdmitted`'s `safeParse({ ... })`.
    const literal = (text: string, fn: string, open: string) => {
      // Fails when the function is missing (`slice(-1)` would leave one character).
      expect(text.indexOf(`function ${fn}(`), fn).toBeGreaterThanOrEqual(0);
      const body = text.slice(text.indexOf(`function ${fn}(`));
      const start = body.indexOf(open) + open.length;
      expect(start, `${fn}: ${open}`).toBeGreaterThan(open.length - 1);
      let depth = 1;
      let i = start;
      for (; i < body.length && depth > 0; i++) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") depth--;
      }
      return body
        .slice(start, i - 1)
        .replace(/\s+/g, " ")
        .trim();
    };
    const awareness = stripComments(SRC_FILES.get("src/server/mcp/awareness.ts") as string);
    const selection = stripComments(SRC_FILES.get("src/server/mcp/inbox-selection.ts") as string);
    const admit = literal(awareness, "admitChatItem", "const item = {");
    const waiting = literal(selection, "chatItemAdmitted", "safeParse({");
    // Both sides parse with the same schema (carried from #2474's review).
    const fnBody = (text: string, fn: string) => {
      const start = text.indexOf(`function ${fn}(`);
      expect(start, fn).toBeGreaterThanOrEqual(0);
      return text.slice(start, text.indexOf("\n}\n", start));
    };
    expect(fnBody(awareness, "admitChatItem")).toContain("inboxChatMessageSchema.safeParse(item)");
    expect(fnBody(selection, "chatItemAdmitted")).toContain("inboxChatMessageSchema.safeParse({");
    // The positive anchor: the literal is the one with the six fields.
    expect(admit).toContain("id: msg.id");
    expect(admit).toContain("replyTo: msg.replyTo");
    expect(waiting).toBe(admit);
  });

  it("ownership.ts imports nothing from awareness (the chat side is reached only through its seam)", () => {
    const text = SRC_FILES.get(OWNERSHIP) as string;
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      // A bare side-effect import (3b-2b1b-claimable).
      ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((m) => m[1] as string);
    // The positive anchor: the scan finds the module's real imports.
    expect(specifiers).toContain("../ownership-flag.js");
    expect(specifiers.filter((spec) => /awareness/.test(spec))).toEqual([]);
    // 3b-2b1b-claimable: the open documents come through a seam, never the
    // registry or the document service (either import would close a cycle).
    expect(
      specifiers.filter((spec) => /documents\//.test(spec) || /document-service/.test(spec)),
    ).toEqual([]);
  });
});

describe("claimable work (#2358 PR 3b-2b1b-claimable)", () => {
  const OWNERSHIP = "src/server/sessions/ownership.ts";
  const index = SRC_FILES.get("src/server/index.ts") as string;

  it("only index.ts installs the open-documents source, once, as a statement of main() before either transport branch", () => {
    expect(filesMentioning("setOpenDocumentIdsSource", [OWNERSHIP])).toEqual([
      "src/server/index.ts",
    ]);
    // The import and the one call.
    expect(stripComments(index).match(/\bsetOpenDocumentIdsSource\b/g)).toHaveLength(2);
    const line = "  setOpenDocumentIdsSource(() => getOpenDocs().keys());";
    const wired = index.indexOf(line);
    expect(wired).toBeGreaterThan(-1);
    expect(index.indexOf(line, wired + 1)).toBe(-1);
    const http = index.indexOf('if (transportMode === "http") {\n    // Ownership');
    const stdio = index.indexOf('setOwnershipTransportMode("stdio");');
    expect(http).toBeGreaterThan(-1);
    expect(stdio).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(http);
    expect(wired).toBeLessThan(stdio);
    // Inside the module: the declaration (pinned by its text; the
    // assignment regex below does not match it, a type annotation sits
    // between the name and its `=`) and two assignments, the setter's and the
    // reset's; nothing in it calls the setter.
    const ownership = stripComments(SRC_FILES.get(OWNERSHIP) as string);
    expect(ownership).toContain("let openDocumentIds: () => Iterable<string> = () => [];");
    expect(ownership.match(/\bopenDocumentIds\s*=(?!=)/g)).toHaveLength(2);
    expect(ownership.match(/\bsetOpenDocumentIdsSource\b/g)).toHaveLength(1);
  });

  it("the decision's helpers are unexported and named by no other src file", () => {
    const ownership = stripComments(SRC_FILES.get(OWNERSHIP) as string);
    for (const helper of ["anotherSessionConnected", "claimableByTandem", "claimableChatWaiting"]) {
      // The positive anchor: the definition is there.
      expect(ownership, helper).toContain(`function ${helper}(`);
      expect(ownership, helper).not.toMatch(new RegExp(`export\\s+function\\s+${helper}\\b`));
      expect(filesMentioning(helper), helper).toEqual([OWNERSHIP]);
    }
  });
});
