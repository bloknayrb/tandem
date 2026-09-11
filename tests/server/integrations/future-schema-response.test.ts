/**
 * #1792 item 2 — a downgraded `integrations.json` must not become
 * `{"error":"INTERNAL"}`.
 *
 * `storage.ts` throws a precise error, but all seven `sendInternal` callers
 * flattened it to a generic 500, so after a downgrade the wizard and the
 * Settings Claude Code tab were dead with no hint of why. The branch lives
 * inside `sendInternal` so a new caller cannot forget it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_INTEGRATIONS,
  type IntegrationsRoutesDeps,
  registerIntegrationsRoutes,
} from "../../../src/server/integrations/api-routes.js";
import { createKeychain } from "../../../src/server/integrations/keychain.js";
import { INTEGRATIONS_SCHEMA_VERSION } from "../../../src/server/integrations/schema.js";
import {
  createIntegrationsStore,
  IntegrationsFutureSchemaError,
} from "../../../src/server/integrations/storage.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";
import { ERROR_CODE_INTEGRATIONS_FUTURE_SCHEMA } from "../../../src/shared/integrations/contract.js";

const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

function makeApp(deps: IntegrationsRoutesDeps): Express {
  const app = express();
  app.use(express.json());
  registerIntegrationsRoutes(app, passthrough, passthrough, deps);
  return app;
}

async function get(app: Express, url: string): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      headers: { Origin: `http://${TAURI_HOSTNAME}` },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("integrations.json written by a newer Tandem (#1792)", () => {
  let tmpDir: string;
  const FUTURE = INTEGRATIONS_SCHEMA_VERSION + 7;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-future-int-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects the read with IntegrationsFutureSchemaError carrying both versions", async () => {
    const filePath = path.join(tmpDir, "integrations.json");
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ schemaVersion: FUTURE, integrations: [] }),
      "utf-8",
    );

    const store = createIntegrationsStore(tmpDir);
    await expect(store.read()).rejects.toBeInstanceOf(IntegrationsFutureSchemaError);
    await store.read().catch((err: unknown) => {
      const e = err as IntegrationsFutureSchemaError;
      expect(e.found).toBe(FUTURE);
      expect(e.supported).toBe(INTEGRATIONS_SCHEMA_VERSION);
      // The path IS carried on the error — for the server log line only.
      expect(e.filePath).toBe(filePath);
    });
  });

  it("answers 409 with an actionable message and no filesystem path", async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, "integrations.json"),
      JSON.stringify({ schemaVersion: FUTURE, integrations: [] }),
      "utf-8",
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp({
      installSkill: async () => ({ written: true }),
      store: createIntegrationsStore(tmpDir),
      keychain: createKeychain({
        get: () => null,
        set: () => {},
        delete: () => false,
      }),
      readExisting: async () => [],
      serverVersion: "0.0.0-test",
    });

    const res = await get(app, API_INTEGRATIONS);
    errorSpy.mockRestore();

    expect(res.status).toBe(409);
    const body = res.body as { error?: string; code?: string; message?: string };
    expect(body.error).toBe("CONFLICT");
    expect(body.code).toBe(ERROR_CODE_INTEGRATIONS_FUTURE_SCHEMA);
    expect(body.message).toContain(String(FUTURE));
    expect(body.message).toContain(String(INTEGRATIONS_SCHEMA_VERSION));
    // These routes are LAN-reachable, so neither the absolute path nor its
    // DIRECTORY may reach the wire. Asserting on both rather than "no
    // substring of the path" — the message legitimately says
    // "integrations.json", which makes the latter unsatisfiable. This is what
    // kills the naive `message: err.message` fix.
    const full = path.join(tmpDir, "integrations.json");
    expect(body.message).not.toContain(full);
    expect(body.message).not.toContain(path.dirname(full));
  });
});
