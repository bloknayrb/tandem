# Licensing Gate — Implementation Plan (PR-A: license-state engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the server-side license-state engine — trial clock, license resolution, build flag, appData storage, boot wiring, and the read-only status route — all dark behind a build flag, on top of the shipped `verifier.ts` primitives.

**Architecture:** A single pure-resolver module (`license-state.ts`) re-reads `trial.json` + `license.json` from appData on every call (no cache) and returns one of `trial`/`licensed`/`restricted`. The build flag (`__LICENSE_GATE_ENABLED__`, default false) makes it short-circuit to unrestricted. Boot wires `ensureTrialStarted()` + nothing-blocking before the transport branch; a loopback/LAN-split `GET /api/license/status` exposes state to the client + updater.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `crypto`, vitest, Express, tsup `define`, `env-paths`, existing `atomicWrite`.

**Spec:** `docs/superpowers/specs/2026-06-18-licensing-system-design.md` (triple-reviewed). This plan implements §1–§3 + §5 status route. Surfaces A/B (gate enforcement), activation POST, CLI, client UX, grandfather, and L3 are PR-B…F (planned separately).

## Global Constraints

- **Y.Map key strings from `shared/constants.ts`** — never raw literals (not relevant to PR-A but holds repo-wide).
- **stdout reserved** — `console.*` redirects to stderr; never log to stdout.
- **Build flag default: `false`** — PR-A must be byte-identical to today's behavior when the flag is off and `TANDEM_LICENSE_GATE` is unset.
- **Trial math: epoch arithmetic only** — `expiresAt = epoch(firstRunAt) + 14*86_400_000`; never `setDate`/calendar add.
- **`license-state.ts` resolution re-reads per call** — no long-lived cache (kills two-writer staleness).
- **All file writes via `atomicWrite`** from `src/server/file-io/index.js`.
- **Status route PII rule:** full state (incl. licensee name) loopback-only via raw `isLoopback(req.socket.remoteAddress)`; non-loopback gets a scrubbed `{ gateActive, status, daysRemaining, updateWindowCurrent }`.
- **Re-verify license blob on read**; assert known `metadata.version` major (currently `"1.0"`), reject unknown.
- Conventional commits, Co-Authored-By trailer, files end with newline.

---

### Task 1: `TRIAL_DAYS` + appData path helpers for license files

**Files:**
- Modify: `src/server/license/license-types.ts` (add `LicenseState`, `LicenseStatus`, `TrialFile`, `LicenseFile`)
- Create: `src/server/license/paths.ts`
- Test: `tests/server/license-state.test.ts`

**Interfaces:**
- Produces: `licenseFilePath(appDataDir): string`, `trialFilePath(appDataDir): string`, `TRIAL_DAYS = 14`, `TRIAL_MS`, and the new types.

- [ ] **Step 1: Write the failing test**
```ts
// tests/server/license-state.test.ts
import { describe, expect, it } from "vitest";
import path from "path";
import { licenseFilePath, trialFilePath, TRIAL_DAYS, TRIAL_MS } from "../../src/server/license/paths.js";

describe("license paths + constants", () => {
  it("derives license/trial paths under the appData dir", () => {
    expect(licenseFilePath("/data")).toBe(path.join("/data", "license.json"));
    expect(trialFilePath("/data")).toBe(path.join("/data", "trial.json"));
  });
  it("trial is 14 days in ms", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_MS).toBe(14 * 86_400_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/server/license-state.test.ts -t "license paths"`
Expected: FAIL (`paths.js` not found).

- [ ] **Step 3: Implement `paths.ts` + types**
```ts
// src/server/license/paths.ts
import path from "path";
export const TRIAL_DAYS = 14;
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;
export const licenseFilePath = (appDataDir: string): string => path.join(appDataDir, "license.json");
export const trialFilePath = (appDataDir: string): string => path.join(appDataDir, "trial.json");
```
```ts
// append to src/server/license/license-types.ts
export type LicenseStatus = "trial" | "licensed" | "restricted";
export interface TrialFile { version: 1; firstRunAt: string }
export interface LicenseFile { version: 1; blob: string }
export interface LicenseState {
  gateActive: boolean;
  status: LicenseStatus;
  trial?: { firstRunAt: string; expiresAt: string; daysRemaining: number };
  license?: LicenseMetadata;
  updateWindowCurrent: boolean;
  licenseId?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/server/license-state.test.ts -t "license paths"`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/license/paths.ts src/server/license/license-types.ts tests/server/license-state.test.ts
git commit -m "feat(license): add license-state paths + types + trial constants (#1116)"
```

---

### Task 2: Build flag (`GATE_ENABLED`) + tsup define + ship-dark guard

**Files:**
- Modify: `tsup.config.ts` (add const + define to server & cli `define` blocks)
- Create: `src/server/license/gate-flag.ts`
- Test: `tests/server/license-state.test.ts`

**Interfaces:**
- Produces: `GATE_ENABLED: boolean` (build-flag derived, env fallback for dev/test).

- [ ] **Step 1: Write the failing test** (env-fallback path, since the define is undefined under vitest)
```ts
// add to tests/server/license-state.test.ts
import { readGateFlag } from "../../src/server/license/gate-flag.js";
describe("gate flag", () => {
  it("off by default when define + env unset", () => {
    expect(readGateFlag({ defineValue: undefined, env: {} })).toBe(false);
  });
  it("env TANDEM_LICENSE_GATE=1 enables in dev/test", () => {
    expect(readGateFlag({ defineValue: undefined, env: { TANDEM_LICENSE_GATE: "1" } })).toBe(true);
  });
  it("define wins over env when present", () => {
    expect(readGateFlag({ defineValue: false, env: { TANDEM_LICENSE_GATE: "1" } })).toBe(false);
    expect(readGateFlag({ defineValue: true, env: {} })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/server/license-state.test.ts -t "gate flag"`
Expected: FAIL (`gate-flag.js` not found).

- [ ] **Step 3: Implement `gate-flag.ts`**
```ts
// src/server/license/gate-flag.ts
declare const __LICENSE_GATE_ENABLED__: boolean;

/** Pure, injectable for tests. */
export function readGateFlag(deps: {
  defineValue: boolean | undefined;
  env: Record<string, string | undefined>;
}): boolean {
  if (typeof deps.defineValue !== "undefined") return deps.defineValue;
  return deps.env.TANDEM_LICENSE_GATE === "1";
}

const defineValue = typeof __LICENSE_GATE_ENABLED__ !== "undefined" ? __LICENSE_GATE_ENABLED__ : undefined;

// Ship-dark guard: a production sidecar bundle MUST carry the define. If it
// doesn't, we'd silently fall back to the env var and ship dark regardless of
// the build const — warn loudly so a bad bundle is caught at boot.
if (process.env.TANDEM_TAURI_SIDECAR === "1" && typeof defineValue === "undefined") {
  console.error("[license] WARNING: __LICENSE_GATE_ENABLED__ define missing in sidecar bundle — gate flag falling back to env var");
}

export const GATE_ENABLED = readGateFlag({ defineValue, env: process.env });
```

- [ ] **Step 4: Add the tsup define** (in `tsup.config.ts`, near the top add `const LICENSE_GATE_ENABLED = false;`, then add to BOTH the server and cli `define` blocks):
```ts
__LICENSE_GATE_ENABLED__: JSON.stringify(LICENSE_GATE_ENABLED),
```

- [ ] **Step 5: Run test + typecheck**
Run: `npx vitest run tests/server/license-state.test.ts -t "gate flag" && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**
```bash
git add tsup.config.ts src/server/license/gate-flag.ts tests/server/license-state.test.ts
git commit -m "feat(license): add license-gate build flag (dark by default) (#1116)"
```

---

### Task 3: `resolveLicenseState()` — the pure resolver

**Files:**
- Create: `src/server/license/license-state.ts`
- Test: `tests/server/license-state.test.ts`

**Interfaces:**
- Consumes: `verifyLicense` (verifier.js), `licenseFilePath`/`trialFilePath`/`TRIAL_MS` (paths.js), types.
- Produces: `resolveLicenseState({ appDataDir, now, gateEnabled }): LicenseState`. Reads files synchronously (boot + per-dispatch hot path); memoizes blob-verify by SHA-256.

- [ ] **Step 1: Write failing tests** (cover: flag-off bypass; trial active; trial boundary; expired→restricted; valid→licensed; grandfathered never expires; tampered/expired license→restricted; unknown version→restricted)
```ts
// add to tests/server/license-state.test.ts — uses a temp dir + a locally-signed license
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { resolveLicenseState } from "../../src/server/license/license-state.js";
import { canonicalize } from "../../src/server/license/verifier.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "lic-")); }
function writeTrial(dir: string, firstRunAt: string) {
  fs.writeFileSync(path.join(dir, "trial.json"), JSON.stringify({ version: 1, firstRunAt }));
}
const DAY = 86_400_000;

describe("resolveLicenseState", () => {
  it("flag off ⇒ licensed/unrestricted, no files touched", () => {
    const s = resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: false });
    expect(s).toMatchObject({ gateActive: false, status: "licensed", updateWindowCurrent: true });
  });
  it("trial active within 14 days", () => {
    const dir = tmp(); const t0 = 1_000_000_000_000;
    writeTrial(dir, new Date(t0).toISOString());
    const s = resolveLicenseState({ appDataDir: dir, now: () => t0 + 5 * DAY, gateEnabled: true });
    expect(s.status).toBe("trial");
    expect(s.trial?.daysRemaining).toBe(9);
  });
  it("restricted after 14 days with no license", () => {
    const dir = tmp(); const t0 = 1_000_000_000_000;
    writeTrial(dir, new Date(t0).toISOString());
    const s = resolveLicenseState({ appDataDir: dir, now: () => t0 + 15 * DAY, gateEnabled: true });
    expect(s.status).toBe("restricted");
  });
  it("trial with no trial.json yet ⇒ trial (day 0)", () => {
    const s = resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: true });
    expect(s.status).toBe("trial");
  });
});
```
(Add a `licensed` test that signs metadata with a temp key — but note `resolveLicenseState` verifies against the *embedded* public key, so use the same pattern as `license.test.ts`'s "Production Key Verification": skip-if-no-`keys/` private key, OR factor the public key as an injectable dep. **Decision:** add an optional `verify` injection to `resolveLicenseState` deps defaulting to `verifyLicense`, so tests inject a temp-key verifier.)

Revise the resolver signature to:
```ts
resolveLicenseState({ appDataDir, now, gateEnabled, verify = verifyLicense })
```
and add licensed/grandfathered/tampered/unknown-version cases using an injected `verify`.

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx vitest run tests/server/license-state.test.ts -t "resolveLicenseState"`
Expected: FAIL (`license-state.js` not found).

- [ ] **Step 3: Implement `resolveLicenseState`**
```ts
// src/server/license/license-state.ts
import crypto from "crypto";
import fs from "fs";
import { verifyLicense } from "./verifier.js";
import { licenseFilePath, trialFilePath, TRIAL_MS, TRIAL_DAYS } from "./paths.js";
import type { LicenseState, LicenseMetadata, LicenseFile, TrialFile } from "./license-types.js";

const KNOWN_VERSION_MAJORS = new Set(["1"]);
function knownVersion(v: string): boolean { return KNOWN_VERSION_MAJORS.has(v.split(".")[0]); }

let _verifyCache: { hash: string; meta: LicenseMetadata } | null = null;
function verifyMemo(blob: string, verify: (b: string) => LicenseMetadata): LicenseMetadata {
  const hash = crypto.createHash("sha256").update(blob).digest("hex");
  if (_verifyCache && _verifyCache.hash === hash) return _verifyCache.meta;
  const meta = verify(blob);              // throws on bad sig / expired
  _verifyCache = { hash, meta };
  return meta;
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return null; }
}

export function resolveLicenseState(deps: {
  appDataDir: string;
  now: () => number;
  gateEnabled: boolean;
  verify?: (b: string) => LicenseMetadata;
}): LicenseState {
  const { appDataDir, now, gateEnabled, verify = verifyLicense } = deps;
  if (!gateEnabled) {
    return { gateActive: false, status: "licensed", updateWindowCurrent: true };
  }

  // 1. Valid license ⇒ licensed
  const lf = readJson<LicenseFile>(licenseFilePath(appDataDir));
  if (lf?.blob) {
    try {
      const meta = verifyMemo(lf.blob, verify);
      if (knownVersion(meta.version)) {
        const updateWindowCurrent = meta.expiresAt === null || new Date(meta.expiresAt).getTime() > now();
        return { gateActive: true, status: "licensed", license: meta, licenseId: meta.id, updateWindowCurrent };
      }
    } catch { /* fall through to trial/restricted */ }
  }

  // 2. Trial clock
  const tf = readJson<TrialFile>(trialFilePath(appDataDir));
  const firstRunAt = tf?.firstRunAt ? new Date(tf.firstRunAt).getTime() : now();
  const expiresAt = firstRunAt + TRIAL_MS;
  if (now() < expiresAt) {
    const daysRemaining = Math.max(0, Math.ceil((expiresAt - now()) / 86_400_000));
    return {
      gateActive: true, status: "trial", updateWindowCurrent: false,
      trial: { firstRunAt: new Date(firstRunAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), daysRemaining },
    };
  }
  return { gateActive: true, status: "restricted", updateWindowCurrent: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**
Run: `npx vitest run tests/server/license-state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/license/license-state.ts tests/server/license-state.test.ts
git commit -m "feat(license): resolveLicenseState (trial/licensed/restricted, no cache) (#1116)"
```

---

### Task 4: `ensureTrialStarted()` + `activateLicense()`

**Files:**
- Modify: `src/server/license/license-state.ts`
- Test: `tests/server/license-state.test.ts`

**Interfaces:**
- Produces: `ensureTrialStarted(appDataDir, now, gateEnabled): Promise<void>` (writes `trial.json` once, only when gate enabled, exclusive create); `activateLicense(appDataDir, blob): Promise<LicenseState>` (verify + known-version + atomic persist).

- [ ] **Step 1: Write failing tests**
```ts
import { ensureTrialStarted, activateLicense } from "../../src/server/license/license-state.js";
describe("ensureTrialStarted", () => {
  it("writes trial.json once when gate enabled", async () => {
    const dir = tmp();
    await ensureTrialStarted(dir, () => 123, true);
    const a = fs.readFileSync(path.join(dir, "trial.json"), "utf-8");
    await ensureTrialStarted(dir, () => 999, true); // must NOT overwrite
    expect(fs.readFileSync(path.join(dir, "trial.json"), "utf-8")).toBe(a);
  });
  it("writes nothing when gate disabled", async () => {
    const dir = tmp();
    await ensureTrialStarted(dir, () => 123, false);
    expect(fs.existsSync(path.join(dir, "trial.json"))).toBe(false);
  });
});
describe("activateLicense", () => {
  it("rejects a garbage blob", async () => {
    await expect(activateLicense(tmp(), "not-a-license")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**
Run: `npx vitest run tests/server/license-state.test.ts -t "ensureTrialStarted"`
Expected: FAIL.

- [ ] **Step 3: Implement** (append to `license-state.ts`; use `atomicWrite` + exclusive create for the trial file)
```ts
import { atomicWrite } from "../file-io/index.js";

export async function ensureTrialStarted(appDataDir: string, now: () => number, gateEnabled: boolean): Promise<void> {
  if (!gateEnabled) return;
  const p = trialFilePath(appDataDir);
  if (fs.existsSync(p)) return;
  const body: TrialFile = { version: 1, firstRunAt: new Date(now()).toISOString() };
  try {
    fs.writeFileSync(p, JSON.stringify(body), { flag: "wx" }); // exclusive: first writer wins under concurrent boots
  } catch {
    // already created by a racing process — leave it
  }
}

export async function activateLicense(appDataDir: string, blob: string): Promise<LicenseState> {
  const meta = verifyLicense(blob);              // throws on bad sig / expired
  if (!knownVersion(meta.version)) throw new Error(`Unsupported license version: ${meta.version}`);
  const body: LicenseFile = { version: 1, blob };
  await atomicWrite(licenseFilePath(appDataDir), JSON.stringify(body));
  _verifyCache = null;                            // force re-verify on next resolve
  return resolveLicenseState({ appDataDir, now: () => Date.now(), gateEnabled: true });
}
```

- [ ] **Step 4: Run tests + typecheck**
Run: `npx vitest run tests/server/license-state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/license/license-state.ts tests/server/license-state.test.ts
git commit -m "feat(license): ensureTrialStarted + activateLicense (#1116)"
```

---

### Task 5: Boot wiring — start trial pre-transport

**Files:**
- Modify: `src/server/index.ts` (call `ensureTrialStarted` in `main()` before the transport branch / server bind, after appData init)

**Interfaces:**
- Consumes: `ensureTrialStarted`, `GATE_ENABLED`, `resolveAppDataDir`.

- [ ] **Step 1: Add the call** (in `main()`, before the HTTP/stdio transport branch and before welcome.md/CHANGELOG open):
```ts
import { ensureTrialStarted } from "./license/license-state.js";
import { GATE_ENABLED } from "./license/gate-flag.js";
// ... inside main(), early (after APP_DATA_DIR is known):
await ensureTrialStarted(resolveAppDataDir(), () => Date.now(), GATE_ENABLED);
```

- [ ] **Step 2: Typecheck + smoke**
Run: `npm run typecheck`
Expected: clean. (Manual: with `TANDEM_LICENSE_GATE` unset, `npm run dev:server` boots and writes no `trial.json`; with `TANDEM_LICENSE_GATE=1`, it writes one once.)

- [ ] **Step 3: Commit**
```bash
git add src/server/index.ts
git commit -m "feat(license): start trial clock at boot (gate-gated, pre-transport) (#1116)"
```

---

### Task 6: `GET /api/license/status` (loopback full / LAN scrubbed)

**Files:**
- Modify: `src/shared/api-paths.ts` (add `API_LICENSE_STATUS = "/api/license/status"`)
- Create: `src/server/mcp/routes/license.ts` (`handleGetLicenseStatus`)
- Modify: `src/server/mcp/api-routes.ts` (register the GET route with the standard middleware)
- Test: `tests/server/license-status-route.test.ts`

**Interfaces:**
- Consumes: `resolveLicenseState`, `GATE_ENABLED`, `isLoopback` (auth middleware), `resolveAppDataDir`.
- Produces: handler returning full `LicenseState` to loopback, scrubbed `{gateActive,status,daysRemaining,updateWindowCurrent}` to non-loopback.

- [ ] **Step 1: Write failing test** (use supertest-style or the project's existing route test harness; assert loopback returns name, non-loopback omits it). Mirror an existing route test in `tests/server/`.
```ts
// tests/server/license-status-route.test.ts — shape test of the scrub helper
import { scrubForNonLoopback } from "../../src/server/mcp/routes/license.js";
import { describe, expect, it } from "vitest";
it("scrubs PII for non-loopback", () => {
  const full = { gateActive: true, status: "licensed", updateWindowCurrent: true,
    license: { name: "Jane", email: "j@x.com", id: "abc", type: "personal", createdAt: "", expiresAt: null, version: "1.0" },
    licenseId: "abc" } as const;
  expect(scrubForNonLoopback(full as any)).toEqual({ gateActive: true, status: "licensed", daysRemaining: undefined, updateWindowCurrent: true });
});
```

- [ ] **Step 2: Run to verify fail**
Run: `npx vitest run tests/server/license-status-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handler + scrub + register**
```ts
// src/server/mcp/routes/license.ts
import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
import { resolveLicenseState } from "../../license/license-state.js";
import { GATE_ENABLED } from "../../license/gate-flag.js";
import { resolveAppDataDir } from "../../platform.js";
import type { LicenseState } from "../../license/license-types.js";

export function scrubForNonLoopback(s: LicenseState) {
  return { gateActive: s.gateActive, status: s.status, daysRemaining: s.trial?.daysRemaining, updateWindowCurrent: s.updateWindowCurrent };
}

export function handleGetLicenseStatus(req: Request, res: Response): void {
  const state = resolveLicenseState({ appDataDir: resolveAppDataDir(), now: () => Date.now(), gateEnabled: GATE_ENABLED });
  if (isLoopback(req.socket.remoteAddress)) { res.json(state); return; }
  res.json(scrubForNonLoopback(state));
}
```
Register in `api-routes.ts` alongside other GETs: `app.get(API_LICENSE_STATUS, <standard apiMiddleware>, handleGetLicenseStatus);` and add the path to `api-paths.ts`.

- [ ] **Step 4: Run tests + typecheck**
Run: `npx vitest run tests/server/license-status-route.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/api-paths.ts src/server/mcp/routes/license.ts src/server/mcp/api-routes.ts tests/server/license-status-route.test.ts
git commit -m "feat(license): GET /api/license/status (loopback full / LAN scrubbed) (#1116)"
```

---

## Self-Review (PR-A vs spec §1–§3, §5-status)

- §1 state model → Tasks 3 (resolver, no cache, 3 states, version check) ✓
- §2 build flag → Task 2 (define both bundles, env fallback, ship-dark guard) ✓
- §3 storage → Tasks 1 (paths), 4 (ensureTrialStarted exclusive-create gate-gated, activateLicense atomic) ✓
- §1 boot pre-transport → Task 5 ✓
- §5 status route loopback/LAN split → Task 6 ✓
- Epoch math (Global Constraint) → Task 3 uses `+ TRIAL_MS`, `getTime()` compares ✓
- Re-verify on read + memo by hash → Task 3 `verifyMemo` ✓

**Deferred to later PRs (not PR-A):** Surface A Hocuspocus readOnly (PR-B), Surface B gatedTool + `/api` gate + `POST /api/license/activate` route + CLI (PR-C), client UX (PR-D), grandfather (PR-E), L3 updater (PR-F). Each gets its own plan section.

**Note on the `verifyMemo` module-global cache:** it's a single-entry verify memo keyed by blob hash (a perf detail, not the state cache the reviews flagged) — state itself is still recomputed every `resolveLicenseState` call. `activateLicense` clears it. Acceptable; revisit if multi-license ever exists.
