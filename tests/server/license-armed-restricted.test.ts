import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The armed-and-restricted fixture (#1788 item 4) — **the only test in the repo
 * where `GATE_ENABLED` is really `true`.**
 *
 * Why it is load-bearing: `TANDEM_LICENSE_GATE=1 npx vitest run` was green over
 * two independent fail-opens, because no `trial.json` means a *fresh* trial and
 * every other unit test injects `gateEnabled` / a hand-built `LicenseState`
 * itself. Nothing ever ran the real disk path with the real flag in a restricted
 * state, which is how a blank `firstRunAt` (a perpetual trial) and an asymmetric
 * `tandem_resolveAnnotation` could both be true with nothing red.
 *
 * `vi.hoisted` carries exactly ONE line — the env var — because it runs before
 * this file's own imports, so `fs` / `path` / `os` are still in TDZ inside it.
 * `GATE_ENABLED` is a module-level const read once at import
 * (`gate-flag.ts:33`), so the var has to be set before any import of the license
 * tree; nothing else here has a pre-import ordering requirement. Keeping the
 * block to one line also matters because a throw during *collection* skips
 * `afterAll`, and a mkdtemp in a hoisted block would leak on that path.
 *
 * Nothing here flips a shipped const: `LICENSE_GATE_ENABLED` stays `false` in
 * `tsup.config.ts`. This exercises the ARMED gate via the `TANDEM_LICENSE_GATE`
 * env fallback that `readGateFlag` reads under tsx/vitest.
 */
vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

import { applyConnectionGate } from "../../src/server/license/connection-gate.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import { resolveLiveLicenseState } from "../../src/server/license/license-state.js";
import { trialFilePath } from "../../src/server/license/paths.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";

const DAY = 86_400_000;

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Capture tool handlers off a fake receiver. Both registrars use
 * `server.tool(name, desc, schema, handler)` AND
 * `server.registerTool(name, config, handler)` — the handler is the LAST
 * argument in either form (the `captureTandemOpen` shape at
 * `license-force-open-gate.test.ts:38-50`).
 */
function captureHandlers(): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const capture = (name: string, ...rest: unknown[]) => {
    tools[name] = rest[rest.length - 1] as Handler;
  };
  const fakeServer = { tool: capture, registerTool: capture };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAnnotationTools(fakeServer as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDocumentTools(fakeServer as any);
  return tools;
}

/**
 * Decode the JSON error envelope a tool result carries. `mcpError`
 * (`src/server/mcp/response.ts:77-92`) JSON-stringifies `{error, code, message}`
 * into `content[0].text`, so reading `result.code` directly is `undefined` and
 * every assertion built on it passes vacuously.
 */
function envelope(result: unknown): { error?: boolean; code?: string } {
  const r = result as { content?: Array<{ text: string }> };
  if (!r?.content?.[0]?.text) return {};
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return {};
  }
}

/**
 * Every fixture dir this file created, so `afterAll` can remove them. Tracked
 * rather than kept as a single `let`, because `useAppDataDir` is called more
 * than once and the second call would otherwise orphan the first.
 */
const createdDirs: string[] = [];

/** Write a `trial.json` into a fresh app-data fixture and point the env at it. */
function useAppDataDir(trialBody: unknown): string {
  // The `tandem-` prefix is required: `tests/server/platform.test.ts` asserts
  // `SESSION_DIR` contains "tandem".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-armed-"));
  createdDirs.push(dir);
  fs.writeFileSync(trialFilePath(dir), JSON.stringify(trialBody));
  process.env.TANDEM_APP_DATA_DIR = dir;
  return dir;
}

let savedAppDataDir: string | undefined;
let savedGateFlag: string | undefined;

beforeAll(() => {
  savedAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  savedGateFlag = process.env.TANDEM_LICENSE_GATE;
  // 30 days old ⇒ the 14-day trial has ended ⇒ restricted. Legal to set here
  // rather than in the hoisted block because `resolveAppDataDir()` re-reads
  // `process.env` on every call (`src/server/platform.ts:11-14`).
  useAppDataDir({ version: 1, firstRunAt: new Date(Date.now() - 30 * DAY).toISOString() });
});

afterAll(() => {
  // Restore by ABSENCE. `process.env.X = undefined` writes the STRING
  // "undefined", which `platform.ts:12-13` accepts as a real override — every
  // later file in this forks worker would then resolve app data to a relative
  // `undefined/` directory.
  if (savedAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = savedAppDataDir;
  if (savedGateFlag === undefined) delete process.env.TANDEM_LICENSE_GATE;
  else process.env.TANDEM_LICENSE_GATE = savedGateFlag;
  // The env restore alone left two `tandem-license-armed-*` dirs, each holding
  // a `trial.json`, in the OS temp dir on every `npm test` / pre-push / CI run.
  // `force` so a dir the OS already reaped is not an error; the loop is
  // deliberately after the env restore, which is the half a later file depends
  // on.
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("license gate, ARMED and RESTRICTED", () => {
  // Anti-vacuity, and it comes first: without it every assertion below passes on
  // a dark build, which is exactly how the suite stayed green over two
  // fail-opens. `toMatchObject` against the whole object rather than `.status`,
  // because `LicenseState`'s `{gateActive:false}` arm carries no `status` and a
  // bare `.status` read does not typecheck (`typecheck:tests` is in Done-when).
  it("is actually armed, and the fixture actually resolves restricted", () => {
    expect(GATE_ENABLED).toBe(true);
    expect(resolveLiveLicenseState()).toMatchObject({
      gateActive: true,
      status: "restricted",
    });
  });

  describe("Surface A — Hocuspocus connection gate", () => {
    // The state is resolved FROM DISK, not hand-built. `connection-gate.ts:27-38`
    // takes `state` as a parameter and never reads `GATE_ENABLED`, so a literal
    // would pass on a dark build too — passing `resolveLiveLicenseState()` is
    // what makes this armed coverage. Said out loud because "it already has a
    // Surface A test" is what would otherwise simplify it back.
    it("clamps a document room to read-only", () => {
      const conn: { readOnly?: boolean } = {};
      const clamped = applyConnectionGate(conn, "some-doc-room", resolveLiveLicenseState());
      expect(clamped).toBe(true);
      expect(conn.readOnly).toBe(true);
    });

    it("leaves CTRL_ROOM writable (chat / mode / awareness escape hatch)", () => {
      const conn: { readOnly?: boolean } = {};
      const clamped = applyConnectionGate(conn, CTRL_ROOM, resolveLiveLicenseState());
      expect(clamped).toBe(false);
      expect(conn.readOnly).toBeUndefined();
    });
  });

  describe("Surface B — MCP tools", () => {
    // Three NAMED handlers, not the whole gate list: that keeps every handler
    // with real side effects (`tandem_scratchpad`, `tandem_save`, `tandem_open`)
    // uninvoked, so this file needs no document fixture and no cleanup.
    let tools: Record<string, Handler>;
    beforeAll(() => {
      tools = captureHandlers();
    });

    it("tandem_edit answers LICENSE_REQUIRED", async () => {
      const env = envelope(await tools.tandem_edit({}));
      expect(env.code).toBe("LICENSE_REQUIRED");
    });

    // The behavioural pin for #1788 fix 2. Revert `annotations.ts`'s
    // `gatedTool("tandem_resolveAnnotation", …)` back to `withErrorBoundary` and
    // this goes red — as does the static row in license-gate-coverage.test.ts.
    // Two independent detectors, deliberately.
    it("tandem_resolveAnnotation answers LICENSE_REQUIRED (decision F)", async () => {
      const env = envelope(await tools.tandem_resolveAnnotation({}));
      expect(env.code).toBe("LICENSE_REQUIRED");
    });

    it("tandem_getTextContent is NOT gated (the read escape hatch)", async () => {
      const env = envelope(await tools.tandem_getTextContent({}));
      expect(env.code).not.toBe("LICENSE_REQUIRED");
    });
  });

  // The fail-open, end to end, through the real disk path. The unit cases in
  // license-state.test.ts cannot reach this: they inject `appDataDir`, so they
  // never exercise `resolveLiveLicenseState`. Before #1788's fix this resolved
  // to a fresh 14-day trial on EVERY dispatch.
  it('firstRunAt: "" resolves restricted, not a perpetual trial', () => {
    useAppDataDir({ version: 1, firstRunAt: "" });
    expect(resolveLiveLicenseState()).toMatchObject({
      gateActive: true,
      status: "restricted",
    });
  });
});
