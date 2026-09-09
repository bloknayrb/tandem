import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mutatingRegistrations,
  type Registration,
  unlistedRegistrars,
} from "../helpers/api-route-source.js";

/**
 * Surface-B registration coverage for the **`/api` half** (#1116, ADR-040) —
 * the twin of `license-gate-coverage.test.ts`, which has done this for MCP
 * tools since the gate was built.
 *
 * **Why this file exists.** `CLAUDE.md` Critical Rule 9 says a new mutating MCP
 * tool or `/api` route joins the gated set in BOTH halves, and then says the
 * quiet part: *"the MCP half is CI-enforced by
 * `tests/server/license-gate-coverage.test.ts`; the `/api` half is doc-review
 * only"* — its only review being a prose list in `docs/licensing-explained.md`.
 * The two halves therefore fail differently. A forgotten MCP tool turns `check`
 * red. A forgotten `/api` route ships, and is noticed if and when someone reads
 * a document.
 *
 * That is not hypothetical. `POST /api/mode/release` mutates annotation records
 * across every open document and was absent from the prose list entirely until
 * #1821's sweep read the source — so nothing, human or machine, had ever taken
 * a view on whether it should be gated. It is ungated below, deliberately and
 * now on the record, which is the whole difference this file makes.
 *
 * **What it does NOT do.** It takes no position on whether the gated set is
 * drawn correctly — that is a product decision, and an open one: the #1346
 * amendment argues the seven middleware mounts should be deleted outright,
 * because they are the *browser's* write path and the user keeps writing under
 * decision 1. If that lands, the fix is to flip seven rows here and say why.
 * A row flip is a diff someone reviews. A silently ungated route is not.
 *
 * Static, like its MCP twin, and for the same reason: the regression class is
 * "wrong middleware chain at registration", which a booted-server test with the
 * gate dark cannot see at all.
 */

const SERVER_DIR = join(import.meta.dirname, "..", "..", "src", "server");

type Gate = "gated" | "ungated";
type RouteGate = { constant: string; gate: Gate; why: string };

/**
 * One row per mutating `/api` route, keyed on the path CONSTANT.
 *
 * `gated` = the registration chain carries `licenseGateMiddleware`.
 * `ungated` = it does not, and that is intended.
 *
 * The `why` on an ungated row is the part that has to be written by a person.
 * Everything else here is mechanical; this column is the review, and an
 * unconvincing sentence in it is the signal the row is wrong.
 *
 * Rationale for the seven `gated` rows is uniform and matches
 * `docs/licensing-explained.md`: each writes document content or the annotation
 * store from the browser, so it is the twin of a `gatedTool` MCP write and must
 * not be the way around Surface A.
 */
const ROUTE_GATES: RouteGate[] = [
  // ---- document / annotation writes: gated (#1116 Surface B) ----
  { constant: "API_SCRATCHPAD", gate: "gated", why: "authors content into a fresh document" },
  { constant: "API_APPLY_CHANGES", gate: "gated", why: "rewrites document content" },
  { constant: "API_DOCUMENT_RELOAD", gate: "gated", why: "replaces in-memory document content" },
  {
    constant: "API_BACKUPS_RESTORE",
    gate: "gated",
    why: "overwrites the document with a snapshot",
  },
  {
    constant: "API_EXTERNAL_CONFLICT_RESOLVE",
    gate: "gated",
    why: "writes a conflict resolution into the document",
  },
  { constant: "API_ANNOTATION_REPLY", gate: "gated", why: "writes the annotation store" },
  { constant: "API_REMOVE_ANNOTATION", gate: "gated", why: "writes the annotation store" },

  // ---- reads, escape hatches and tab management: ungated ----
  {
    constant: "API_OPEN",
    gate: "ungated",
    why: "plain open is the read/export escape hatch — but it carries an IN-HANDLER gate on the `force === true` sub-path (`mcp/routes/open.ts`), which discards the in-memory annotation, awareness and content maps and rebuilds the document from disk. The chain regex cannot see that; IN_HANDLER_GATED below asserts it directly, and `license-force-open-gate.test.ts` covers it behaviourally",
  },
  {
    constant: "API_SAVE",
    gate: "ungated",
    why: "escape hatch: writing your own file out must survive a restricted licence, exactly like `tandem_save`",
  },
  {
    constant: "API_CONVERT",
    gate: "ungated",
    why: "writes a separate export file, not document content — same call as `tandem_convertToMarkdown` in the MCP table",
  },
  {
    constant: "API_RENAME",
    gate: "ungated",
    why: "filesystem op, not a content write — same call as `tandem_rename` in the MCP table",
  },
  {
    constant: "API_UPLOAD",
    gate: "ungated",
    why: "an open path: it admits a document, it does not author into one",
  },
  { constant: "API_CLOSE", gate: "ungated", why: "tab management" },
  {
    constant: "API_MODE_RELEASE",
    gate: "ungated",
    why: "clears `heldInSolo` markers after a Solo→Tandem toggle the user can already perform: mode lives in CTRL_ROOM, which Surface A deliberately never marks read-only. Gating it would strand a restricted user's held annotations behind a Held pill with no way to release them, while their reads stay open — worse than what gating would prevent. Reviewed 2026-09-08; it had never been reviewed before, being absent from the prose list",
  },
  {
    constant: "API_LICENSE_ACTIVATE",
    gate: "ungated",
    why: "gating this makes the gate unescapable — a restricted user could never install the licence that lifts it",
  },
  {
    constant: "API_STORE_RECLAIM_LOCK",
    gate: "ungated",
    why: "lockfile housekeeping, not a write",
  },
  {
    constant: "API_SESSIONS_DELETE",
    gate: "ungated",
    why: "session management, not document content",
  },
  {
    constant: "API_SESSIONS_CLEAR",
    gate: "ungated",
    why: "session management, not document content",
  },
  {
    constant: "API_ROTATE_TOKEN",
    gate: "ungated",
    why: "auth plumbing; a restricted install must still be able to re-key itself, and the CLI calls it with no Origin",
  },
  { constant: "API_SHUTDOWN", gate: "ungated", why: "process lifecycle" },

  // ---- CTRL_ROOM and transport: ungated ----
  {
    constant: "API_CHANNEL_AWARENESS",
    gate: "ungated",
    why: "channel shim transport; CTRL_ROOM awareness, which Surface A never locks",
  },
  {
    constant: "API_CHANNEL_ERROR",
    gate: "ungated",
    why: "channel shim transport: error reporting",
  },
  {
    constant: "API_CHANNEL_REPLY",
    gate: "ungated",
    why: "CTRL_ROOM chat, writable when restricted — matches `tandem_reply` in the MCP table",
  },
  { constant: "API_CHANNEL_PERMISSION", gate: "ungated", why: "channel shim permission relay" },
  {
    constant: "API_CHANNEL_PERMISSION_VERDICT",
    gate: "ungated",
    why: "channel shim permission relay",
  },
  { constant: "API_CHAT", gate: "ungated", why: "clears CTRL_ROOM chat, not document content" },

  // ---- integrations / launcher / models: ungated ----
  {
    constant: "API_INTEGRATIONS",
    gate: "ungated",
    why: "AI-client connection config; a restricted user must still be able to fix a broken connection",
  },
  { constant: "API_INTEGRATIONS_APPLY", gate: "ungated", why: "writes MCP config, not documents" },
  {
    constant: "API_INTEGRATIONS_SECRET",
    gate: "ungated",
    why: "keychain reference for a connection",
  },
  {
    constant: "API_INTEGRATIONS_INSTALL_CLAUDE_CODE",
    gate: "ungated",
    why: "installs the AI client; gating it would trap a restricted user with no way to connect",
  },
  {
    constant: "API_LAUNCHER_RELAUNCH",
    gate: "ungated",
    why: "starts a Claude session, not a write",
  },
  { constant: "API_LAUNCHER_START_FRESH", gate: "ungated", why: "starts a Claude session" },
  { constant: "API_LAUNCHER_START", gate: "ungated", why: "starts a Claude session" },
  {
    constant: "API_LAUNCHER_WORKING_DIRECTORY",
    gate: "ungated",
    why: "launcher config, not document content",
  },
  { constant: "API_LAUNCHER_CWD_PREVIEW", gate: "ungated", why: "read-shaped preview" },
  {
    constant: "API_MODELS",
    gate: "ungated",
    why: "BYO-model config (ADR-039), itself dark behind BYO_MODELS_ENABLED; the collaborator's own restriction check is in `local-model/tools.ts:305`",
  },
  { constant: "API_MODELS_SECRET", gate: "ungated", why: "provider API key, not document content" },
];

/**
 * Routes gated inside the handler rather than by middleware — the shape a
 * `licenseGateMiddleware` grep cannot find, and the reason CLAUDE.md warns to
 * audit the handler body rather than the registration site.
 *
 * Asserted BOTH ways below: each named handler must call `licenseGate()`, and
 * no other module may, so a new in-handler gate cannot appear unlisted.
 */
const IN_HANDLER_GATED: Record<string, string> = {
  API_OPEN: "mcp/routes/open.ts",
};

/**
 * Modules allowed to call `licenseGate()` directly. The two handler sites, the
 * definition, and the local-model collaborator's own copy.
 */
const LICENSE_GATE_CALLERS = new Set([
  "mcp/license-gate.ts",
  "mcp/routes/open.ts",
  "mcp/document.ts",
  "local-model/tools.ts",
]);

const REGISTRATIONS = mutatingRegistrations();
const BY_CONSTANT = new Map<string, Registration[]>();
for (const r of REGISTRATIONS) {
  BY_CONSTANT.set(r.constant, [...(BY_CONSTANT.get(r.constant) ?? []), r]);
}

const GATED = ROUTE_GATES.filter((r) => r.gate === "gated").map((r) => r.constant);
const UNGATED = ROUTE_GATES.filter((r) => r.gate === "ungated").map((r) => r.constant);

describe("Surface B /api gated-route registration coverage", () => {
  it.each(GATED)("%s is registered with licenseGateMiddleware", (constant) => {
    const regs = BY_CONSTANT.get(constant) ?? [];
    expect(regs.length, `${constant} is not registered as a mutating route at all`).toBeGreaterThan(
      0,
    );
    for (const reg of regs) {
      expect(
        reg.call.includes("licenseGateMiddleware"),
        `${constant} in ${reg.file} must carry licenseGateMiddleware (license fail-open)`,
      ).toBe(true);
    }
  });

  it.each(UNGATED)("%s stays ungated", (constant) => {
    for (const reg of BY_CONSTANT.get(constant) ?? []) {
      expect(
        reg.call.includes("licenseGateMiddleware"),
        `${constant} in ${reg.file} must NOT be license-gated — see its row's rationale`,
      ).toBe(false);
    }
  });

  /**
   * Completeness. `ROUTE_GATES` protects only the routes it NAMES, so without
   * this a new mutating route ships ungated AND green — the exact fail-open the
   * MCP twin exists to prevent, which is why that suite carries the same check.
   */
  it("every mutating /api route has a row, and every row is a real route", () => {
    const registered = new Set(REGISTRATIONS.map((r) => r.constant));
    const listed = new Set(ROUTE_GATES.map((r) => r.constant));

    const missing = [...registered].filter((c) => !listed.has(c)).sort();
    expect(
      missing,
      `New mutating /api route(s) with no row in ROUTE_GATES. Add each with gate + why — ` +
        `and per CLAUDE.md Critical Rule 9, gate the MCP twin at the same time: ${missing.join(", ")}`,
    ).toEqual([]);

    const stale = [...listed].filter((c) => !registered.has(c)).sort();
    expect(
      stale,
      `ROUTE_GATES names route(s) that no longer register: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The outer net: a whole new registrar file. Without it, the check above is
   * blind by construction — it only reads the five files it was told about.
   */
  it("no registrar outside API_REGISTRARS declares a mutating route", () => {
    expect(
      unlistedRegistrars(),
      "These files register mutating routes but are not in API_REGISTRARS, so no row in " +
        "ROUTE_GATES can cover them. Add the file to the helper's list, then add its routes here.",
    ).toEqual([]);
  });

  it("no row is left without a rationale", () => {
    const blank = ROUTE_GATES.filter((r) => r.why.trim().length < 12).map((r) => r.constant);
    expect(blank, `Rows with no usable rationale: ${blank.join(", ")}`).toEqual([]);
  });
});

describe("in-handler license gates", () => {
  it.each(Object.entries(IN_HANDLER_GATED))("%s is gated inside %s", (_constant, module) => {
    const src = readFileSync(join(SERVER_DIR, module), "utf-8");
    expect(src, `${module} must call licenseGate() directly`).toMatch(/licenseGate\(\)/);
  });

  /**
   * The other direction, and the one that matters more: an in-handler gate
   * added in a module nobody listed is invisible to every check above — it
   * would read as an ungated route that is actually gated, which breaks the
   * escape hatch rather than opening a hole, and is just as wrong.
   */
  it("only the listed modules call licenseGate() directly", () => {
    const callers = new Set<string>();
    const walk = (dir: string, base = ""): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          if (/licenseGate\(\)/.test(readFileSync(join(dir, entry.name), "utf-8"))) {
            callers.add(rel);
          }
        }
      }
    };
    walk(SERVER_DIR);
    const unexpected = [...callers].filter((c) => !LICENSE_GATE_CALLERS.has(c)).sort();
    expect(
      unexpected,
      `Unlisted module(s) call licenseGate() directly: ${unexpected.join(", ")}. ` +
        "Add them to LICENSE_GATE_CALLERS and, if a route is now gated in its handler, " +
        "to IN_HANDLER_GATED.",
    ).toEqual([]);
  });
});
