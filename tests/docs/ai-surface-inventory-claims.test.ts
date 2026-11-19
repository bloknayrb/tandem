import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE,
  AI_REFUSAL_UNLICENSED_MESSAGE,
} from "../../src/shared/license-copy.js";

/**
 * Guards the AI-surface inventory in `docs/licensing-explained.md` — the
 * discovery step for #1346 / the ADR-040 amendment.
 *
 * The amendment asks whether every AI surface shares one enforcement point. That
 * question was unanswerable as written because nothing enumerated the surfaces:
 * the "gated set" list in the same document is an inventory of **operations**,
 * a different axis, which is why chat, the push/wake paths and the local-model
 * loop appear nowhere in it despite all three being AI surfaces.
 *
 * An enumeration that silently goes short is worse than none — Critical Rule 9
 * establishes that this repo uses such lists as review inventories, so a
 * reviewer reads an omission as "covered". Hence this test, and hence the rule
 * it follows from its sibling `loopback-gate-claims.test.ts`: **the sets are
 * DERIVED FROM SOURCE, never seeded from the prose.** A test built from the
 * names the doc already claims only confirms the doc against itself; this one
 * has to be able to fail when a *new* AI surface appears.
 *
 * The enforcement assertions flipped with #1521, as this header predicted: they
 * now pin that every AI choke point CONSULTS the licence decision
 * (`license/ai-refusal.ts`), derived from source, and that the local-model
 * loop's private copy is gone.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DOC = join(REPO_ROOT, "docs", "licensing-explained.md");

function read(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf-8");
}

/** Drop comments so an identifier NAMED in prose isn't mistaken for one CALLED. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Repo-relative source files under the given directories. */
function sourcesUnder(...dirs: string[]): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs)) {
      const childAbs = join(abs, entry);
      const childRel = `${rel}/${entry}`;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else if (entry.endsWith(".ts"))
        out.push({ path: childRel, src: readFileSync(childAbs, "utf-8") });
    }
  };
  for (const dir of dirs) walk(join(REPO_ROOT, dir), dir);
  return out;
}

describe("AI surface inventory (#1346 discovery)", () => {
  /**
   * Choke point for row 4. Every AI-authored chat message goes through this one
   * function; the surface gate's chat check has exactly one place to live only
   * for as long as that stays true.
   */
  it("chat has exactly one write choke point, with the four callers the doc names", () => {
    const callers = sourcesUnder("src")
      .filter(({ path, src }) => {
        if (path.endsWith("src/server/mcp/awareness.ts")) return false; // the definition
        return /\bappendClaudeChatMessage\s*\(/.test(stripComments(src));
      })
      .map(({ path }) => path)
      .sort();

    expect(
      callers,
      [
        "A new caller of appendClaudeChatMessage means a new AI chat write surface.",
        "Add it to the 'AI surfaces' table in docs/licensing-explained.md, or route it",
        "through an existing surface. Do not just widen this list.",
      ].join(" "),
    ).toEqual([
      "src/server/local-model/collaborator.ts",
      // #1123 part B, R11: Tandem's line at the user's own switch back to
      // Claude, a notice routed through the choke point (licence-refused).
      "src/server/local-period-wiring.ts",
      "src/server/mcp/channel-routes.ts",
    ]);

    // The third caller is inside the defining module (`tandem_reply`). Asserting
    // it by shape is not enough: excluding the whole module would make a FOURTH
    // chat write added here — the likeliest place for one — invisible to the test
    // whose job is catching exactly that. So count the call sites instead, and
    // pin which tool the one call belongs to.
    const awareness = stripComments(read("src", "server", "mcp", "awareness.ts"));
    const callSites = awareness.match(/\bappendClaudeChatMessage\s*\(/g) ?? [];
    const definition = /export function appendClaudeChatMessage\s*\(/.test(awareness) ? 1 : 0;
    expect(
      callSites.length - definition,
      [
        "awareness.ts gained (or lost) an appendClaudeChatMessage call. A new one is a",
        "new AI chat write; add it to the 'AI surfaces' table in docs/licensing-explained.md.",
      ].join(" "),
    ).toBe(1);
    expect(awareness).toMatch(/tandem_reply[\s\S]{0,600}appendClaudeChatMessage\s*\(/);
  });

  /**
   * Choke point for row 5. `"external"` is the kind that means "leaves this
   * process toward a model" — the Solo gate is keyed on it, and so is the
   * licence refusal (#1521).
   *
   * The regex accepts an optional third argument (`{ onRevoke }`, #1521) after
   * `"external"`. It was WIDENED for that rather than the expected list being
   * shrunk: with the old `"external"\s*\)` anchor, SSE and the wake socket —
   * which now pass `onRevoke` — would have silently dropped out of the match,
   * and a guard that only sees the supervisor sees nothing.
   */
  it("push/wake has exactly one subscription choke point, with three consumers", () => {
    const consumers = sourcesUnder("src")
      .filter(({ path, src }) => {
        if (path.endsWith("src/server/events/queue.ts")) return false; // the definition
        return /\bsubscribe\s*\(\s*[\w.]+\s*,\s*"external"\s*[,)]/.test(stripComments(src));
      })
      .map(({ path }) => path)
      .sort();

    expect(
      consumers,
      [
        "A new external subscriber is a new push surface: it tells a model that",
        "document state changed. Add it to the 'AI surfaces' table in",
        "docs/licensing-explained.md.",
      ].join(" "),
    ).toEqual([
      "src/server/events/sse.ts",
      "src/server/events/wake-socket.ts",
      "src/server/launcher/supervisor.ts",
    ]);
  });

  /**
   * The load-bearing positive (#1521). Every AI choke point calls the licence
   * decision. Derived from source: each module named here must CALL it (not
   * merely mention it), so a refactor that drops the call turns this red.
   */
  it("every AI choke point consults the licence decision", () => {
    const CHOKE_POINTS: Record<string, RegExp> = {
      // row 1: POST + GET /mcp and stdio server mode
      "src/server/mcp/server.ts": /\baiRefusal\(\)/,
      // row 4: the chat write, and the shim's reply (the approval relay was deleted in #1885)
      "src/server/mcp/awareness.ts": /\baiRefusal\(\)/,
      "src/server/mcp/channel-routes.ts": /\baiRefusal\(\)/,
      // row 5: fan-out, SSE, wake socket, launcher spawn
      "src/server/events/queue.ts": /\baiRefusal\(\)/,
      "src/server/events/sse.ts": /\baiRefusal\(\)/,
      "src/server/events/wake-socket.ts": /\baiRefusal\(\)/,
      "src/server/launcher/supervisor.ts": /\bdecideRefusal\(\)/,
      // row 6: the local-model loop, per run
      "src/server/local-model/collaborator.ts": /\bdecideRefusal\(\)/,
    };
    const missing = Object.entries(CHOKE_POINTS)
      .filter(([file, call]) => !call.test(stripComments(read(file))))
      .map(([file]) => file);
    expect(missing, "These AI choke points no longer consult the licence decision").toEqual([]);
  });

  /**
   * Row 6's private copy is gone (#1521): the loop is refused per run in the
   * collaborator, so the dispatcher carries no licence check of its own.
   */
  it("the local-model dispatcher carries no licence check of its own", () => {
    const tools = stripComments(read("src", "server", "local-model", "tools.ts"));
    expect(tools).not.toMatch(/licenseGate|LICENSE_REQUIRED|isLicenseRestricted|aiRefusal/);
  });

  /**
   * Decision 5 ("always unlicensed, never expired") reached the refusal copy
   * with #1521, and the doc's "contradicts decision 5" debt paragraph went with it.
   */
  it("the refusal copy says unlicensed, never that a trial ended", () => {
    // The runtime values, not a source slice: the messages are composed from
    // shared openings, so the literal no longer sits after each constant's name.
    for (const message of [
      AI_REFUSAL_UNLICENSED_MESSAGE,
      AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE,
    ]) {
      expect(message).toMatch(/^Tandem is unlicensed/);
      expect(message).not.toMatch(/trial has ended|expired/i);
    }
    expect(readFileSync(DOC, "utf-8")).not.toMatch(/contradicts decision 5/);
  });

  /**
   * Row 3's correction, derived rather than asserted.
   *
   * The doc claims the gated `/api` routes are the BROWSER's write path, which
   * is why the reshape ungates them instead of giving them an admission point.
   * That claim is load-bearing and counter-intuitive — read the other way it
   * says "an unlicensed install serves POST /api/apply-changes ungated", which
   * looks like a security hole — so it cannot rest on prose agreeing with
   * itself. The first cut of this guard did exactly that (two `toMatch` calls
   * against the doc's own sentences) and would have passed unchanged after a
   * server-side caller appeared, which is the one event that falsifies it.
   *
   * A "caller" is a file that both names the path constant and calls `fetch` —
   * the route modules name the constant for `assertOriginAllowlisted` without
   * ever fetching it, and this separates the two without a path allowlist.
   */
  it("the formerly gated /api routes are called only from the browser client", () => {
    const ROUTE_CONSTS = [
      "API_ANNOTATION_REPLY",
      "API_REMOVE_ANNOTATION",
      "API_APPLY_CHANGES",
      "API_SCRATCHPAD",
      "API_DOCUMENT_RELOAD",
      "API_BACKUPS_RESTORE",
      "API_EXTERNAL_CONFLICT_RESOLVE",
      // Row 3's former "+1 in-handler": the force:true sub-path of open.
      "API_OPEN",
    ];

    const nonClientCallers = sourcesUnder("src")
      .filter(({ path }) => !path.startsWith("src/client/"))
      .filter(({ src }) => {
        const clean = stripComments(src);
        return (
          /\bfetch\s*\(/.test(clean) &&
          ROUTE_CONSTS.some((c) => new RegExp(`\\b${c}\\b`).test(clean))
        );
      })
      .map(({ path }) => path)
      .sort();

    expect(
      nonClientCallers,
      [
        "A non-client caller of a formerly gated /api route appeared. #1521 ungated these",
        "routes on the grounds that only the browser calls them — if that is no longer",
        "true, the route is an AI surface and needs an admission point. Fix the code or",
        "the 'Row 3 is the browser' paragraph in docs/licensing-explained.md, not this list.",
      ].join(" "),
    ).toEqual([]);
  });

  it("the doc enumerates all six surfaces", () => {
    const doc = readFileSync(DOC, "utf-8");
    const section = /## AI surfaces — the #1346 inventory([\s\S]*?)\n## Delivery/.exec(doc)?.[1];
    expect(section, "the AI surfaces section is gone").toBeDefined();

    for (const row of [
      "MCP over HTTP",
      "MCP over stdio",
      "`/api` mutating twins",
      "Chat",
      "Event push / wake",
      "Local-model collaborator",
    ]) {
      expect(section).toContain(row);
    }
    // Surface A is explicitly excluded rather than forgotten.
    expect(section).toMatch(/not\* an AI surface/i);

    expect(section).toMatch(/Row 3 is the browser/);
  });
});

/** The innermost named function around `node`: a declaration, a method, or a
 *  function or arrow bound to a name (`const f = () => …`, `f: () => …`). */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      if (n.name) return n.name.getText();
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name) {
        return p.name.getText();
      }
    }
  }
  return "<top>";
}

/** Every node of `src` that `pick` keys, as `enclosingName:key`. Parsed, so a
 *  comment or a string that mentions a name is never a site. */
function sitesIn(src: string, pick: (node: ts.Node) => string | null): string[] {
  const file = ts.createSourceFile("s.ts", src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    const key = pick(node);
    if (key !== null) out.push(`${enclosingName(node)}:${key}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out.sort();
}

/** An identifier named `name` that is not the name a declaration declares. */
function isReferenceTo(node: ts.Node, names: readonly string[]): node is ts.Identifier {
  if (!ts.isIdentifier(node) || !names.includes(node.text)) return false;
  const p = node.parent;
  return !((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === node);
}

/** An assignment to `name` whose value is not the literal `false`. */
function raisesFlag(node: ts.Node, name: string): boolean {
  if (!ts.isBinaryExpression(node) || !ts.isIdentifier(node.left) || node.left.text !== name) {
    return false;
  }
  const op = node.operatorToken.kind;
  if (op === ts.SyntaxKind.EqualsToken) return node.right.kind !== ts.SyntaxKind.FalseKeyword;
  return (
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

describe("the launcher's turn writers (#2358 PR 3b-2a, R3.1)", () => {
  // Every turn written to Tandem's Claude's stdin is an AI surface (Critical
  // Rule 9): a new writer must consult the licence decision, as `requestWake`
  // does at its writer (`requestWakeOnSpawn`) and as a spawn does at its
  // admission. A choke-point check that passes the file if it calls
  // `decideRefusal()` anywhere cannot see a new site; these multisets can.
  // Keyed by enclosing named function plus argument, and compared as sorted
  // lists, so a second site with an existing key is a second entry, not
  // hidden behind the first.
  const SUPERVISOR = read("src", "server", "launcher", "supervisor.ts");
  const OBLIGATION = [
    "A new turn writer in supervisor.ts (or a moved one). Every turn written to",
    "Tandem's Claude is an AI surface: it must consult the licence decision",
    "(decideRefusal(), Critical Rule 9) before it writes or owes a wake, and be",
    "listed in docs/licensing-explained.md's launcher row. Then update this list.",
  ].join(" ");

  it("sendTurn's call sites, and every other reference to it", () => {
    // Keyed `function:argument` for a call, `function:<ref>` for a reference
    // that is not called (passed on or aliased).
    const sites = sitesIn(SUPERVISOR, (node) => {
      if (!isReferenceTo(node, ["sendTurn"])) return null;
      const call = node.parent;
      if (ts.isCallExpression(call) && call.expression === node) {
        return call.arguments[0]?.getText() ?? "";
      }
      return "<ref>";
    });
    expect(sites, OBLIGATION).toEqual(
      [
        "flushPendingWake:SUPERVISOR_WAKE_PROMPT",
        "onTandemEvent:SUPERVISOR_WAKE_PROMPT",
        "requestWakeOnSpawn:SUPERVISOR_WAKE_PROMPT",
        "spawnOnce:SUPERVISOR_INITIAL_PROMPT",
        "spawnOnce:SUPERVISOR_WAKE_PROMPT",
        "writeGreeting:SUPERVISOR_GREETING_PROMPT",
      ].sort(),
    );
  });

  it("the writers of a pending wake", () => {
    const sites = sitesIn(SUPERVISOR, (node) => (raisesFlag(node, "pendingWake") ? "" : null));
    expect(sites, OBLIGATION).toEqual(
      [
        "onNoReceipt:",
        "onTandemEvent:",
        "onTandemEvent:",
        "requestWakeOnSpawn:",
        "requestWakeOnSpawn:",
        "sendTurn:",
      ].sort(),
    );
  });

  it("the raw writes to the child's stdin, and the turn serializer, sit only in sendTurn", () => {
    // A write that goes round `sendTurn` (`spawned.stdin.write(serializeUserTurn(…))`
    // anywhere else) would show in neither list above.
    const sites = sitesIn(SUPERVISOR, (node) => {
      if (isReferenceTo(node, ["serializeUserTurn"])) return "serializeUserTurn";
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "write" &&
        /\bstdin\??$/.test(node.expression.getText())
      ) {
        return "stdin.write";
      }
      return null;
    });
    expect(sites, OBLIGATION).toEqual(
      ["<top>:serializeUserTurn", "sendTurn:serializeUserTurn", "sendTurn:stdin.write"].sort(),
    );
  });

  it("the writers of a wake owed across spawns", () => {
    // Not a write to the child by itself — such a wake is written only by a
    // spawn, which passes the licence admission — but a new owing site is
    // listed so its review sees it.
    const sites = sitesIn(SUPERVISOR, (node) =>
      raisesFlag(node, "wakeOwedAcrossSpawns") ? "" : null,
    );
    expect(sites, OBLIGATION).toEqual(
      [
        "armGapWatch:", // the gap watch's callback
        "onLocalPeriodChange:",
        "onLocalPeriodChange:",
        "sendTurn:", // a failed write after teardown
        "setStandby:", // the standby watch's callback
        "startForMessage:",
        "startOrWakeStep:", // a pending restart timer is owed the wake
        "startOrWakeStep:", // before its start
        "teardownTurnDelivery:",
      ].sort(),
    );
  });

  it("start-or-wake and requestWake are not called inside the supervisor either (3b-2a, R2.8)", () => {
    // The R2.8 source pin excludes supervisor.ts. Within it, the only
    // references to the two entry points (and to a spawn's `requestWake`
    // member) are their declarations, the pass's own wake of a live child,
    // and the public seam. Since 3b-2b1c-a, `startOrWake` is called from
    // outside the supervisor (ownership's forward, through the sink
    // `index.ts` sets), never inside it, so this list is unchanged.
    const sites = sitesIn(SUPERVISOR, (node) => {
      if (ts.isIdentifier(node) && (node.text === "startOrWake" || node.text === "requestWake")) {
        const p = node.parent;
        if (ts.isFunctionDeclaration(p) && p.name === node) return `${node.text}<decl>`;
        if ((ts.isMethodSignature(p) || ts.isPropertySignature(p)) && p.name === node) {
          return `${node.text}<signature>`;
        }
        if (ts.isPropertyAccessExpression(p) && p.name === node) return `.${node.text}`;
        if (ts.isShorthandPropertyAssignment(p)) return `${node.text}<returned>`;
        if (ts.isPropertyAssignment(p) && p.name === node) return `${node.text}<member>`;
        return node.text;
      }
      return null;
    });
    expect(sites, OBLIGATION).toEqual(
      [
        "<top>:requestWake<signature>", // the Supervisor interface
        "<top>:startOrWake<signature>",
        "createSupervisor:requestWake<signature>", // activeTurnDelivery's type
        "createSupervisor:requestWake<returned>", // the public seam
        "createSupervisor:startOrWake<returned>",
        "requestWake:requestWake<decl>",
        "requestWake:.requestWake", // activeTurnDelivery?.requestWake()
        "spawnOnce:requestWake<member>", // requestWake: requestWakeOnSpawn
        "startOrWake:startOrWake<decl>",
        "startOrWakeStep:requestWake", // the pass wakes a live child
      ].sort(),
    );
  });

  it("the functions that reach a turn write are referenced only where known", () => {
    // Each function's own declaration is not a reference; every call, and any
    // reference passed on, is.
    const refs = sitesIn(SUPERVISOR, (node) =>
      isReferenceTo(node, [
        "onTandemEvent",
        "flushPendingWake",
        "writeGreeting",
        "requestWakeOnSpawn",
      ])
        ? node.text
        : null,
    );
    expect(refs, OBLIGATION).toEqual(
      [
        "handleStdoutLine:flushPendingWake",
        "sendTurn:flushPendingWake",
        "spawnOnce:onTandemEvent",
        "spawnOnce:requestWakeOnSpawn",
        "spawnOnce:writeGreeting",
        "spawnOnce:writeGreeting",
      ].sort(),
    );
  });

  // How a start pass can be reached inside the supervisor (#2358 PR 3b-2b1a,
  // R0.1). The "not called" list above names only the two entry points; a
  // raise of `startOrWakeOwed` plus a `queueStartPass()`, or a direct
  // `startOrWakeStep()`, would reach the pass without naming either.
  const START_PASS_OBLIGATION = [
    "A new route to a start pass in supervisor.ts (or a moved one). A start pass",
    "can start Tandem's Claude: it must sit behind startOrWake's checks (the flag,",
    "shutdown, the live Off, the licence decision) or be today's arm (the standby",
    "watch). Then update this list.",
  ].join(" ");

  it("the writers of messageStartQueued: the standby watch only (3b-2b1a, R3.2)", () => {
    // Today's arm's pending state: raised by nothing but the watch, so a
    // start-or-wake pass never reads as a chat's start.
    const sites = sitesIn(SUPERVISOR, (node) =>
      raisesFlag(node, "messageStartQueued") ? "" : null,
    );
    expect(sites, START_PASS_OBLIGATION).toEqual(["setStandby:"]);
  });

  it("the writers of startOrWakeOwed", () => {
    const sites = sitesIn(SUPERVISOR, (node) => (raisesFlag(node, "startOrWakeOwed") ? "" : null));
    expect(sites, START_PASS_OBLIGATION).toEqual(["startOrWake:"]);
  });

  it("every reference to startOrWakeStep, queueStartPass and startForMessage", () => {
    // A call to startForMessage is keyed with its argument: `true` is the
    // authority to run today's arm, which starts from Off with no Off check
    // of its own, so only the standby watch may pass it (3b-2b1a, R3.2).
    const refs = sitesIn(SUPERVISOR, (node) => {
      if (!isReferenceTo(node, ["startOrWakeStep", "queueStartPass", "startForMessage"])) {
        return null;
      }
      const call = node.parent;
      if (
        node.text === "startForMessage" &&
        ts.isCallExpression(call) &&
        call.expression === node
      ) {
        return `startForMessage(${call.arguments.map((a) => a.getText()).join(", ")})`;
      }
      return node.text;
    });
    expect(refs, START_PASS_OBLIGATION).toEqual(
      [
        "queueStartPass:startForMessage(false)", // the start-or-wake pass
        "setStandby:startForMessage(true)", // today's arm, the standby watch
        "startForMessage:queueStartPass", // the finally's one re-queue
        "startForMessage:startOrWakeStep", // start-or-wake's share of a pass
        "startOrWake:queueStartPass",
      ].sort(),
    );
  });
});
