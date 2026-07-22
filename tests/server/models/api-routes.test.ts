import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
  type KeychainBackend,
} from "../../../src/server/integrations/keychain.js";
import {
  API_MODELS_SECRET,
  type ModelsRoutesDeps,
  registerModelsRoutes,
} from "../../../src/server/models/api-routes.js";
import { __resetModelRegistryForTests } from "../../../src/server/models/registry.js";
import { createModelStore } from "../../../src/server/models/store.js";
import {
  TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV,
  TAURI_HOSTNAME,
} from "../../../src/shared/constants.js";
import { API_MODELS } from "../../../src/shared/models/contract.js";
import { withEnvOverride } from "../../helpers/env-override.js";

/**
 * Unit tests for `registerModelsRoutes` (#659).
 *
 * Covers the same security gates as the integration secrets routes plus
 * the load-bearing #659 invariant: secrets land under the
 * `KEYCHAIN_SERVICE_MODELS` service, NOT the integrations service. A
 * regression here would silently collide outbound third-party API keys
 * with inbound MCP-client tokens.
 */

const passthrough: import("express").Handler = (_req, _res, next) => next();

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

function makeApp(deps: ModelsRoutesDeps): Express {
  const app = express();
  app.use(express.json());
  registerModelsRoutes(app, passthrough, passthrough, deps);
  return app;
}

function makeAppWithRemoteAddress(deps: ModelsRoutesDeps, addr: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: addr,
      configurable: true,
    });
    next();
  });
  registerModelsRoutes(app, passthrough, passthrough, deps);
  return app;
}

async function request(
  app: Express,
  method: "POST" | "DELETE",
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
          Origin: `http://${TAURI_HOSTNAME}`,
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

describe("models API routes", () => {
  let backend: ReturnType<typeof memoryBackend>;
  let deps: ModelsRoutesDeps;

  beforeEach(() => {
    backend = memoryBackend();
    deps = {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend }),
    };
  });

  describe(`POST/DELETE ${API_MODELS_SECRET}`, () => {
    it("stores a secret under the models service and returns 204", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/models/secrets/ref-abc", {
        secret: "sk-test-DO-NOT-USE-anthropic",
      });
      expect(res.status).toBe(204);
      // Critical: stored under `tandem-models`, NOT `tandem-integrations`.
      expect(backend.entries.get(`${KEYCHAIN_SERVICE_MODELS}::ref-abc`)).toBe(
        "sk-test-DO-NOT-USE-anthropic",
      );
      expect(backend.entries.get(`tandem-integrations::ref-abc`)).toBeUndefined();
    });

    it("rejects a missing/empty secret with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/models/secrets/ref-1", { secret: "" });
      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe("INVALID_SECRET");
    });

    it("rejects a non-string secret with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/models/secrets/ref-1", { secret: 12345 });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized secret with 400", async () => {
      const app = makeApp(deps);
      const res = await request(app, "POST", "/api/models/secrets/ref-1", {
        secret: "x".repeat(8193),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid ref shape with 400", async () => {
      const app = makeApp(deps);
      // Slashes are not in the allowed charset (defends against path traversal).
      const res = await request(app, "POST", "/api/models/secrets/ref%2Fwith%2Fslash", {
        secret: "x",
      });
      expect(res.status).toBe(400);
    });

    it("deletes a stored secret and reports existed=true", async () => {
      const app = makeApp(deps);
      await request(app, "POST", "/api/models/secrets/ref-1", { secret: "x" });
      const res = await request(app, "DELETE", "/api/models/secrets/ref-1");
      expect(res.status).toBe(200);
      expect((res.body as { existed: boolean }).existed).toBe(true);
    });

    it("delete of a non-existent ref reports existed=false", async () => {
      const app = makeApp(deps);
      const res = await request(app, "DELETE", "/api/models/secrets/ref-ghost");
      expect(res.status).toBe(200);
      expect((res.body as { existed: boolean }).existed).toBe(false);
    });
  });

  describe("security gates", () => {
    it("rejects a non-allowlisted Origin on POST", async () => {
      const app = makeApp(deps);
      const res = await request(
        app,
        "POST",
        "/api/models/secrets/ref-1",
        { secret: "x" },
        { Origin: "https://evil.example" },
      );
      expect(res.status).toBe(403);
      expect((res.body as { code?: string }).code).toBe("BAD_ORIGIN");
    });

    it("rejects a non-allowlisted Origin on DELETE", async () => {
      const app = makeApp(deps);
      const res = await request(app, "DELETE", "/api/models/secrets/ref-1", undefined, {
        Origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    });

    it("with TANDEM_ALLOW_UNAUTHENTICATED_LAN=1, non-loopback callers are still rejected", async () => {
      await withEnvOverride(TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV, "1", async () => {
        const app = makeAppWithRemoteAddress(deps, "10.0.0.5");
        const res = await request(app, "POST", "/api/models/secrets/ref-1", {
          secret: "x",
        });
        expect(res.status).toBe(403);
      });
    });
  });
});

describe(`POST ${API_MODELS} (registry relocation, #1123 M1a)`, () => {
  let tmpDir: string;
  let deps: ModelsRoutesDeps;

  const validFile = {
    schemaVersion: 1,
    models: [
      {
        id: "m-1",
        provider: "local-ollama",
        displayName: "Local",
        modelId: "qwen2.5:14b-instruct",
        endpoint: "http://127.0.0.1:11434",
        enabled: true,
      },
    ],
    defaultModelId: "m-1",
  };

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-models-route-"));
    __resetModelRegistryForTests(tmpDir);
    deps = {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend: memoryBackend() }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    __resetModelRegistryForTests();
    vi.restoreAllMocks();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a valid registry file and returns 200; disk round-trips", async () => {
    const app = makeApp(deps);
    const res = await request(app, "POST", API_MODELS, validFile);
    expect(res.status).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect(await createModelStore(tmpDir).read()).toEqual(validFile);
  });

  it("rejects a malformed body with 400 INVALID_MODELS_FILE (no disk write)", async () => {
    const app = makeApp(deps);
    const res = await request(app, "POST", API_MODELS, { schemaVersion: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe("INVALID_MODELS_FILE");
    expect(await createModelStore(tmpDir).read()).toEqual({
      schemaVersion: 1,
      models: [],
      defaultModelId: null,
    });
  });

  it("rejects an unknown key (.strict) — a plaintext apiKey can never persist", async () => {
    const app = makeApp(deps);
    const dirty = {
      ...validFile,
      models: [{ ...validFile.models[0], apiKey: "sk-PLAINTEXT" }],
    };
    const res = await request(app, "POST", API_MODELS, dirty);
    expect(res.status).toBe(400);
  });

  it("rejects a non-allowlisted Origin with 403", async () => {
    const app = makeApp(deps);
    const res = await request(app, "POST", API_MODELS, validFile, {
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("with TANDEM_ALLOW_UNAUTHENTICATED_LAN=1, non-loopback callers are still rejected", async () => {
    await withEnvOverride(TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV, "1", async () => {
      const app = makeAppWithRemoteAddress(deps, "10.0.0.5");
      const res = await request(app, "POST", API_MODELS, validFile);
      expect(res.status).toBe(403);
    });
  });
});
