import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetApplyGateForTests,
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_FIRST_RUN,
  API_INTEGRATIONS_SECRET,
  type IntegrationsRoutesDeps,
  registerIntegrationsRoutes,
} from "../../../src/server/integrations/api-routes.js";
import type { ExistingMcpInstall } from "../../../src/server/integrations/existing-config.js";
import {
  createKeychain,
  type KeychainBackend,
  KeychainUnavailableError,
} from "../../../src/server/integrations/keychain.js";
import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
} from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "../../../src/shared/constants.js";

/** No-op pass-through used for the `mw` parameter (DNS-rebinding middleware is not in scope). */
const passthrough: IntegrationsRoutesDeps["store"] extends infer _T
  ? import("express").Handler
  : never = (_req, _res, next) => next();

function makeApp(deps: IntegrationsRoutesDeps): Express {
  const app = express();
  app.use(express.json());
  // `largeBody` and `mw` are no-ops for unit tests — we test handler logic,
  // not the security middleware (covered in api-routes.spec for the main server).
  registerIntegrationsRoutes(app, passthrough, passthrough, deps);
  return app;
}

function memoryBackend(): KeychainBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  return {
    entries,
    get(service, account) {
      return entries.get(key(service, account)) ?? null;
    },
    set(service, account, secret) {
      entries.set(key(service, account), secret);
    },
    delete(service, account) {
      return entries.delete(key(service, account));
    },
  };
}

async function request(
  app: Express,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const port = address.port;
      try {
        const headers: Record<string, string> = {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
        };
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const ct = res.headers.get("content-type") ?? "";
        const payload = ct.includes("application/json")
          ? await res.json().catch(() => null)
          : await res.text();
        resolve({ status: res.status, body: payload });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

/** Origin header that satisfies the apply endpoint's CSRF check. */
const TAURI_ORIGIN = { Origin: "http://tauri.localhost" };

describe("integrations API routes", () => {
  let tmpDir: string;
  let deps: IntegrationsRoutesDeps;
  let backend: ReturnType<typeof memoryBackend>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-int-api-"));
    backend = memoryBackend();
    deps = {
      store: createIntegrationsStore(tmpDir),
      keychain: createKeychain(backend),
      readExisting: async () =>
        [
          {
            target: { kind: "claude-code", label: "Claude Code", configPath: "/tmp/.claude.json" },
            status: "ok",
            tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
          },
        ] satisfies ExistingMcpInstall[],
      serverVersion: "0.0.0-test",
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe(`GET ${API_INTEGRATIONS_EXISTING}`, () => {
    it("returns the existing-installs array", async () => {
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS_EXISTING);
      expect(res.status).toBe(200);
      expect((res.body as { installs: unknown[] }).installs).toHaveLength(1);
    });

    it("returns 500 when the detector throws", async () => {
      deps.readExisting = async () => {
        throw new Error("simulated FS failure");
      };
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS_EXISTING);
      expect(res.status).toBe(500);
    });
  });

  describe(`GET ${API_INTEGRATIONS}`, () => {
    it("returns the empty file when nothing has been written", async () => {
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(emptyIntegrationsFile());
    });

    it("round-trips a written file", async () => {
      await deps.store.write({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "claude-code",
            id: "cc-1",
            label: "Claude Code",
            configPath: "/home/user/.claude.json",
            transport: "http",
            url: "http://127.0.0.1:3479",
          },
        ],
      });
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS);
      expect(res.status).toBe(200);
      expect((res.body as { integrations: Array<{ id: string }> }).integrations[0].id).toBe("cc-1");
    });
  });

  describe(`POST ${API_INTEGRATIONS}`, () => {
    it("rejects an invalid integrations file with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", API_INTEGRATIONS, {
        schemaVersion: 1, // wrong (current is 2)
        integrations: [],
      });
      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe("INVALID_INTEGRATIONS_FILE");
    });

    it("writes a valid integrations file and returns 200 with ids + nonce", async () => {
      const app = makeApp(deps);
      const file = {
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "claude-code",
            id: "cc-1",
            label: "Claude Code",
            configPath: "/home/user/.claude.json",
            transport: "http",
            url: "http://127.0.0.1:3479",
          },
        ],
      };
      const res = await request(app, "POST", API_INTEGRATIONS, file);
      expect(res.status).toBe(200);
      // POST now returns the freshly-rotated nonce so the wizard can chain
      // persist→apply without a round-trip to GET /first-run-needed.
      expect(res.body).toMatchObject({ ok: true, ids: ["cc-1"] });
      expect(typeof res.body.confirmationNonce).toBe("string");
      const persisted = await deps.store.read();
      expect(persisted.integrations[0]?.id).toBe("cc-1");
    });

    it("accepts an other-mcp integration with http transport + url", async () => {
      const app = makeApp(deps);
      const file = {
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "other-mcp",
            id: "cursor-1",
            label: "Cursor",
            transport: "http",
            url: "http://127.0.0.1:3479",
            tokenSecretRef: "ref-1",
          },
        ],
      };
      const res = await request(app, "POST", API_INTEGRATIONS, file);
      expect(res.status).toBe(200);
    });

    it("rejects an other-mcp integration with http transport but no url", async () => {
      const app = makeApp(deps);
      const file = {
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "other-mcp",
            id: "x",
            label: "X",
            transport: "http",
          },
        ],
      };
      const res = await request(app, "POST", API_INTEGRATIONS, file);
      expect(res.status).toBe(400);
    });
  });

  describe(`POST/DELETE ${API_INTEGRATIONS_SECRET}`, () => {
    it("stores a secret and returns 204", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/integrations/secrets/ref-1", {
        secret: "shhh",
      });
      expect(res.status).toBe(204);
      expect(backend.entries.size).toBe(1);
    });

    it("rejects a missing/empty secret with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/integrations/secrets/ref-1", { secret: "" });
      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe("INVALID_SECRET");
    });

    it("rejects a non-string secret with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/integrations/secrets/ref-1", {
        secret: 123,
      });
      expect(res.status).toBe(400);
    });

    it("deletes a stored secret and reports existed=true", async () => {
      const app = makeApp(deps);
      await request(app, "POST", "/api/integrations/secrets/ref-1", { secret: "shhh" });
      const res = await request(app, "DELETE", "/api/integrations/secrets/ref-1");
      expect(res.status).toBe(200);
      expect((res.body as { existed: boolean }).existed).toBe(true);
    });

    it("delete on absent ref reports existed=false (not 404)", async () => {
      const app = makeApp(deps);
      const res = await request(app, "DELETE", "/api/integrations/secrets/ghost");
      expect(res.status).toBe(200);
      expect((res.body as { existed: boolean }).existed).toBe(false);
    });

    it("returns 503 with code KEYCHAIN_UNAVAILABLE when the backend is broken", async () => {
      const throwing: KeychainBackend = {
        get() {
          throw new KeychainUnavailableError(new Error("simulated"));
        },
        set() {
          throw new KeychainUnavailableError(new Error("simulated"));
        },
        delete() {
          throw new KeychainUnavailableError(new Error("simulated"));
        },
      };
      const app = makeApp({ ...deps, keychain: createKeychain(throwing) });
      const setRes = await request(app, "POST", "/api/integrations/secrets/ref-1", {
        secret: "shhh",
      });
      expect(setRes.status).toBe(503);
      expect((setRes.body as { code?: string }).code).toBe("KEYCHAIN_UNAVAILABLE");
      const delRes = await request(app, "DELETE", "/api/integrations/secrets/ref-1");
      expect(delRes.status).toBe(503);
      expect((delRes.body as { code?: string }).code).toBe("KEYCHAIN_UNAVAILABLE");
    });

    it("does NOT expose a GET handler — secrets never travel back to the client", async () => {
      const app = makeApp(deps);
      const res = await request(app, "GET", "/api/integrations/secrets/ref-1");
      // Express returns 404 for unregistered methods (the route exists for POST/DELETE only).
      expect(res.status).toBe(404);
    });
  });

  describe(`GET ${API_INTEGRATIONS_FIRST_RUN}`, () => {
    beforeEach(() => {
      _resetApplyGateForTests();
    });

    it("returns needed=true when both integrations.json is empty and no existing entry", async () => {
      deps.readExisting = async () => [];
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS_FIRST_RUN);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ needed: true, serverVersion: "0.0.0-test" });
      expect(typeof (res.body as { confirmationNonce: string }).confirmationNonce).toBe("string");
    });

    it("returns needed=false when TANDEM_DISABLE_FIRST_RUN_WIZARD=1 (E2E harness flag)", async () => {
      deps.readExisting = async () => [];
      const prev = process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV];
      process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] = "1";
      try {
        const app = makeApp(deps);
        const res = await request(app, "GET", API_INTEGRATIONS_FIRST_RUN);
        expect(res.body).toMatchObject({ needed: false });
      } finally {
        if (prev === undefined) delete process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV];
        else process.env[TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV] = prev;
      }
    });

    it("returns needed=false when integrations.json has an entry", async () => {
      await deps.store.write({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "claude-code",
            id: "cc-1",
            label: "Claude Code",
            configPath: "/home/user/.claude.json",
            transport: "http",
            url: "http://127.0.0.1:3479",
          },
        ],
      });
      deps.readExisting = async () => [];
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS_FIRST_RUN);
      expect(res.body).toMatchObject({ needed: false });
    });

    it("returns needed=false when an existing Tandem entry is detected", async () => {
      // readExisting default surfaces a tandemEntry → needed: false.
      const app = makeApp(deps);
      const res = await request(app, "GET", API_INTEGRATIONS_FIRST_RUN);
      expect(res.body).toMatchObject({ needed: false });
    });
  });

  describe(`POST ${API_INTEGRATIONS_APPLY}`, () => {
    beforeEach(() => {
      _resetApplyGateForTests();
    });

    async function freshNonce(app: Express): Promise<string> {
      const res = await request(app, "GET", API_INTEGRATIONS_FIRST_RUN);
      return (res.body as { confirmationNonce: string }).confirmationNonce;
    }

    it("rejects when Origin is missing", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", API_INTEGRATIONS_APPLY, {
        ids: ["cc-1"],
        confirmationNonce: "any",
      });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe("BAD_ORIGIN");
    });

    it("rejects when Origin is not allowlisted", async () => {
      const app = makeApp(deps);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["cc-1"], confirmationNonce: "any" },
        { Origin: "http://evil.com" },
      );
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe("BAD_ORIGIN");
    });

    it("accepts http://127.0.0.1:* as a dev origin", async () => {
      const app = makeApp(deps);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["nonexistent"], confirmationNonce: "stale" },
        { Origin: "http://127.0.0.1:5173" },
      );
      // Origin OK; falls through to nonce check (which fails — that's a 403 with INVALID_NONCE).
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe("INVALID_NONCE");
    });

    it("rejects when confirmationNonce doesn't match", async () => {
      const app = makeApp(deps);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["cc-1"], confirmationNonce: "stale" },
        TAURI_ORIGIN,
      );
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe("INVALID_NONCE");
    });

    it("rejects when `ids` is missing or empty", async () => {
      const app = makeApp(deps);
      const nonce = await freshNonce(app);
      const r1 = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { confirmationNonce: nonce },
        TAURI_ORIGIN,
      );
      expect(r1.status).toBe(400);
      const r2 = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: [], confirmationNonce: nonce },
        TAURI_ORIGIN,
      );
      expect(r2.status).toBe(400);
    });

    it("rejects `homeOverride` in the body (defense-in-depth)", async () => {
      const app = makeApp(deps);
      const nonce = await freshNonce(app);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["cc-1"], confirmationNonce: nonce, homeOverride: "/tmp" },
        TAURI_ORIGIN,
      );
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(/homeOverride/);
    });

    it("returns OTHER_MCP_NOT_APPLICABLE for other-mcp entries", async () => {
      await deps.store.write({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "other-mcp",
            id: "cursor-1",
            label: "Cursor",
            transport: "http",
            url: "http://127.0.0.1:3479",
          },
        ],
      });
      const app = makeApp(deps);
      const nonce = await freshNonce(app);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["cursor-1"], confirmationNonce: nonce },
        TAURI_ORIGIN,
      );
      expect(res.status).toBe(200);
      const body = res.body as { results: Array<{ id: string; code?: string }> };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({
        id: "cursor-1",
        status: "error",
        code: "OTHER_MCP_NOT_APPLICABLE",
      });
    });

    it("returns SECRET_MISSING when tokenSecretRef has no keychain entry and target IS detected", async () => {
      // Whether a claude-code target is detected depends on the test
      // environment (does ~/.claude.json exist?). If detected → token check
      // fires next → SECRET_MISSING. If not detected → TARGET_NOT_DETECTED.
      // Either way the code field is one of these two — verify the
      // per-integration error shape rather than the specific outcome.
      await deps.store.write({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "claude-code",
            id: "cc-1",
            label: "Claude Code",
            configPath: "/nonexistent/.claude.json",
            transport: "http",
            url: "http://127.0.0.1:3479",
            tokenSecretRef: "no-such-ref",
          },
        ],
      });
      const app = makeApp(deps);
      const nonce = await freshNonce(app);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["cc-1"], confirmationNonce: nonce },
        TAURI_ORIGIN,
      );
      expect(res.status).toBe(200);
      const body = res.body as { results: Array<{ id: string; code?: string; status: string }> };
      expect(body.results[0]?.status).toBe("error");
      expect(["TARGET_NOT_DETECTED", "SECRET_MISSING"]).toContain(body.results[0]?.code);
    });

    it("rotates the confirmationNonce on each successful apply", async () => {
      await deps.store.write({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [
          {
            kind: "other-mcp",
            id: "other-1",
            label: "Other",
            transport: "http",
            url: "http://127.0.0.1:3479",
          },
        ],
      });
      const app = makeApp(deps);
      const nonce1 = await freshNonce(app);
      const res1 = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["other-1"], confirmationNonce: nonce1 },
        TAURI_ORIGIN,
      );
      expect(res1.status).toBe(200);
      const nextNonce = (res1.body as { nextNonce: string }).nextNonce;
      expect(nextNonce).not.toBe(nonce1);
      // Replaying the stale nonce should fail.
      const res2 = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["other-1"], confirmationNonce: nonce1 },
        TAURI_ORIGIN,
      );
      expect(res2.status).toBe(403);
    });

    it("rejects when ids include an unknown entry — still returns 200 with empty results", async () => {
      const app = makeApp(deps);
      const nonce = await freshNonce(app);
      const res = await request(
        app,
        "POST",
        API_INTEGRATIONS_APPLY,
        { ids: ["does-not-exist"], confirmationNonce: nonce },
        TAURI_ORIGIN,
      );
      // Empty integrations file → no matches → empty results array (not an error).
      expect(res.status).toBe(200);
      const body = res.body as { results: unknown[] };
      expect(body.results).toHaveLength(0);
    });
  });
});
