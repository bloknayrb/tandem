import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  it("chat has exactly one write choke point, with the three callers the doc names", () => {
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
    ).toEqual(["src/server/local-model/collaborator.ts", "src/server/mcp/channel-routes.ts"]);

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
