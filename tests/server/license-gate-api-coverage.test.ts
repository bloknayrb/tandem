import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mutatingRegistrations,
  type Registration,
  unlistedRegistrars,
} from "../helpers/api-route-source.js";

/**
 * Licence coverage for the **`/api` half** (#1521, ADR-040 as amended
 * 2026-10-11): "after the 14 day trial, tandem remains a usable editor, but
 * with no AI features".
 *
 * **What changed.** Until #1521 this table gated seven browser write routes
 * behind `licenseGateMiddleware` — the opposite of the licence, which keeps a
 * keyless editor fully writable. Those seven rows are now `open`, and what this
 * table guards instead is the set of routes that are an AI surface: they refuse
 * with the `LICENSE_REQUIRED` envelope while Tandem is unlicensed.
 *
 * Three kinds of row:
 *  - `refused` — the registration's own handler answers the refusal itself
 *    (`refuseIfUnlicensed` or `sendAiRefusal`)
 *    (`mcp/channel-routes.ts`). Asserted from the registration text.
 *  - `refused-by-supervisor` — a launcher route whose refusal lives in the
 *    supervisor (`startInternal` / `respawn`), not the route. Covered
 *    behaviourally in `tests/server/launcher/license-refusal.test.ts`.
 *  - `open` — a browser or housekeeping write that must never be refused.
 *
 * Static, and fails closed on a NEW mutating route with no row — the decision
 * is a row someone reads, never a silent default.
 */

const SERVER_DIR = join(import.meta.dirname, "..", "..", "src", "server");

type Gate = "refused" | "refused-by-supervisor" | "open";
type RouteGate = { constant: string; gate: Gate; why: string };

/** The seven routes the old Surface B gated. Keyless editing is granted, so they are open. */
const BROWSER_WRITE = "browser write path; keyless editing is granted (#1521)";

/**
 * One row per mutating `/api` route, keyed on the path CONSTANT. The `why` is
 * the part a person writes; an unconvincing sentence is the signal a row is wrong.
 */
const ROUTE_GATES: RouteGate[] = [
  // ---- the old Surface B: browser document / annotation writes, now open ----
  { constant: "API_SCRATCHPAD", gate: "open", why: BROWSER_WRITE },
  { constant: "API_APPLY_CHANGES", gate: "open", why: BROWSER_WRITE },
  { constant: "API_DOCUMENT_RELOAD", gate: "open", why: BROWSER_WRITE },
  { constant: "API_BACKUPS_RESTORE", gate: "open", why: BROWSER_WRITE },
  { constant: "API_EXTERNAL_CONFLICT_RESOLVE", gate: "open", why: BROWSER_WRITE },
  { constant: "API_READ_ONLY_FILE_RESOLVE", gate: "open", why: BROWSER_WRITE },
  { constant: "API_ANNOTATION_REPLY", gate: "open", why: BROWSER_WRITE },
  { constant: "API_REMOVE_ANNOTATION", gate: "open", why: BROWSER_WRITE },

  // ---- reads, file and tab management: open ----
  {
    constant: "API_OPEN",
    gate: "open",
    why: "opening a file, including `force: true` (its in-handler gate went with #1521: re-reading a document from disk is editing, which is granted)",
  },
  {
    constant: "API_SAVE",
    gate: "open",
    why: "writing your own file out; the editor is never refused",
  },
  {
    constant: "API_CONVERT",
    gate: "open",
    why: "writes a separate export file, not document content — same call as `tandem_convertToMarkdown` in the MCP table",
  },
  {
    constant: "API_RENAME",
    gate: "open",
    why: "filesystem op, not a content write — same call as `tandem_rename` in the MCP table",
  },
  {
    constant: "API_UPLOAD",
    gate: "open",
    why: "an open path: it admits a document, it does not author into one",
  },
  { constant: "API_CLOSE", gate: "open", why: "tab management" },
  {
    constant: "API_MODE_RELEASE",
    gate: "open",
    why: "a browser action on the user's own mode (Solo to Tandem release). Decision F (#1788) once asked for it to be gated; #1521 supersedes that: keyless is an editable editor, and the wake this emits is refused at fan-out like any other event",
  },
  {
    constant: "API_LICENSE_ACTIVATE",
    gate: "open",
    why: "refusing this would make the refusal unescapable: an unlicensed user could never install the licence that lifts it",
  },
  {
    constant: "API_STORE_RECLAIM_LOCK",
    gate: "open",
    why: "lockfile housekeeping, not a write",
  },
  {
    constant: "API_SESSIONS_DELETE",
    gate: "open",
    why: "session management, not document content",
  },
  {
    constant: "API_SESSIONS_CLEAR",
    gate: "open",
    why: "session management, not document content",
  },
  {
    constant: "API_ROTATE_TOKEN",
    gate: "open",
    why: "auth plumbing; an unlicensed install must still be able to re-key itself, and the CLI calls it with no Origin",
  },
  { constant: "API_SHUTDOWN", gate: "open", why: "process lifecycle" },

  // ---- channel transport and chat ----
  {
    constant: "API_CHANNEL_AWARENESS",
    gate: "open",
    why: "channel shim health diagnostics; carries no AI content",
  },
  {
    constant: "API_CHANNEL_ERROR",
    gate: "open",
    why: "channel shim health diagnostics: error reporting, no AI content",
  },
  {
    constant: "API_CHANNEL_REPLY",
    gate: "refused",
    why: "Claude's chat write via the channel shim, an AI surface; `appendClaudeChatMessage` refuses and the handler answers before `markUserChatRead`",
  },
  {
    constant: "API_CHANNEL_PERMISSION",
    gate: "refused",
    why: "relays Claude Code's tool-approval prompt, an AI surface",
  },
  {
    constant: "API_CHANNEL_PERMISSION_VERDICT",
    gate: "refused",
    why: "the verdict half of the same AI approval relay",
  },
  {
    constant: "API_CHAT",
    gate: "open",
    why: "the user clearing their own chat history; not an AI action",
  },

  // ---- integrations / launcher / models ----
  {
    constant: "API_INTEGRATIONS",
    gate: "open",
    why: "AI-client connection config; an unlicensed user may still set it up for after activation",
  },
  {
    constant: "API_INTEGRATIONS_WALKTHROUGH_CONFIRM",
    gate: "open",
    why: "the v1.0 walkthrough's Keep (#2198): writes Tandem's own app data and starts nothing itself — the release it asks of the supervisor refuses there (startAfterSetup consults aiRefusal) — so refusing here would trap an unlicensed user in the wizard every launch",
  },
  {
    constant: "API_INTEGRATIONS_APPLY",
    gate: "open",
    why: "writes MCP config, not documents; a claude-code apply then asks the supervisor to start Tandem's Claude (#2197), which the supervisor refuses itself (startAfterSetup and respawn both consult aiRefusal), so refusing here would only block the user's own setup",
  },
  {
    constant: "API_INTEGRATIONS_SECRET",
    gate: "open",
    why: "keychain reference for a connection",
  },
  {
    constant: "API_INTEGRATIONS_INSTALL_CLAUDE_CODE",
    gate: "open",
    why: "installs the AI client; harmless while refused, and needed before activation is useful",
  },
  {
    constant: "API_LAUNCHER_RELAUNCH",
    gate: "refused-by-supervisor",
    why: "starts Tandem's Claude; `respawn` refuses before stopping anything and the route answers 403",
  },
  {
    constant: "API_LAUNCHER_START_FRESH",
    gate: "refused-by-supervisor",
    why: "starts Tandem's Claude; the same `respawn` refusal as relaunch",
  },
  {
    constant: "API_LAUNCHER_START",
    gate: "refused-by-supervisor",
    why: "deferred autostart: the supervisor is created, `startInternal` refuses by returning, the route answers 403 and activation resumes it; the Start control (`userInitiated`, #2195) goes through `respawn`, which refuses before stopping or changing anything",
  },
  {
    constant: "API_LAUNCHER_SETTINGS",
    gate: "open",
    why: "the start mode and lifetime of Tandem's Claude (#2195); nothing on it starts Claude, and turning Claude off must never be refused",
  },
  {
    constant: "API_LAUNCHER_WORKING_DIRECTORY",
    gate: "open",
    why: "launcher config, not document content",
  },
  { constant: "API_LAUNCHER_CWD_PREVIEW", gate: "open", why: "read-shaped preview" },
  {
    constant: "API_MODELS",
    gate: "open",
    why: "BYO-model config (ADR-039), itself dark behind BYO_MODELS_ENABLED; the local model is refused per run in `local-model/collaborator.ts`",
  },
  { constant: "API_MODELS_SECRET", gate: "open", why: "provider API key, not document content" },
];

/** A handler that answers the licence refusal in its own body. */
const REFUSES = /refuseIfUnlicensed\(res\)|sendAiRefusal\(/;

const REGISTRATIONS = mutatingRegistrations();
const BY_CONSTANT = new Map<string, Registration[]>();
for (const r of REGISTRATIONS) {
  BY_CONSTANT.set(r.constant, [...(BY_CONSTANT.get(r.constant) ?? []), r]);
}

const rowsOf = (gate: Gate) => ROUTE_GATES.filter((r) => r.gate === gate).map((r) => r.constant);
const REFUSED = rowsOf("refused");
const BY_SUPERVISOR = rowsOf("refused-by-supervisor");
const OPEN = rowsOf("open");

describe("/api licence coverage (#1521)", () => {
  // Anti-vacuity: an empty bucket makes its `it.each` assert nothing.
  it("every bucket is non-empty", () => {
    expect(REFUSED.length).toBeGreaterThan(0);
    expect(BY_SUPERVISOR.length).toBeGreaterThan(0);
    expect(OPEN.length).toBeGreaterThan(0);
  });

  it.each(REFUSED)("%s refuses inside its registered handler", (constant) => {
    const regs = BY_CONSTANT.get(constant) ?? [];
    expect(regs.length, `${constant} is not registered as a mutating route at all`).toBeGreaterThan(
      0,
    );
    for (const reg of regs) {
      expect(
        REFUSES.test(reg.call),
        `${constant} in ${reg.file} must answer the licence refusal (AI surface fail-open)`,
      ).toBe(true);
    }
  });

  it.each([...OPEN, ...BY_SUPERVISOR])("%s is not refused at registration", (constant) => {
    for (const reg of BY_CONSTANT.get(constant) ?? []) {
      expect(
        REFUSES.test(reg.call),
        `${constant} in ${reg.file} must NOT be licence-refused — see its row's rationale`,
      ).toBe(false);
    }
  });

  /**
   * Completeness. `ROUTE_GATES` protects only the routes it NAMES, so without
   * this a new mutating route would ship with no decision recorded.
   */
  it("every mutating /api route has a row, and every row is a real route", () => {
    const registered = new Set(REGISTRATIONS.map((r) => r.constant));
    const listed = new Set(ROUTE_GATES.map((r) => r.constant));

    const missing = [...registered].filter((c) => !listed.has(c)).sort();
    expect(
      missing,
      `New mutating /api route(s) with no row in ROUTE_GATES. Add each with gate + why: ${missing.join(", ")}`,
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

describe("the old Surface B is gone", () => {
  /**
   * The middleware, `gatedTool` and the in-handler `licenseGate()` calls were
   * deleted with #1521. A source sweep, not a name list, so a re-introduction
   * anywhere in `src/server` turns this red.
   */
  it("nothing in src/server mounts licenseGateMiddleware or calls licenseGate() / gatedTool()", () => {
    const hits: string[] = [];
    const walk = (dir: string, base = ""): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          const src = readFileSync(join(dir, entry.name), "utf-8");
          if (/licenseGateMiddleware|\blicenseGate\(\)|\bgatedTool\(/.test(src)) hits.push(rel);
        }
      }
    };
    walk(SERVER_DIR);
    expect(hits).toEqual([]);
  });
});
