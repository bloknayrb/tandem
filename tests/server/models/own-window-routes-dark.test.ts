import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startMcpServerHttp } from "../../../src/server/mcp/server.js";
import {
  __flushLocalModelAnnouncedForTests,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import { __resetLocalModelSettingsForTests } from "../../../src/server/models/local-model-settings.js";
import {
  __resetModelRegistryForTests,
  getCachedModelsFile,
  getModelsEtag,
} from "../../../src/server/models/registry.js";
import { MODELS_FILE_NAME } from "../../../src/server/models/store.js";
import { BYO_MODELS_ENABLED } from "../../../src/shared/constants.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  ERROR_CODE_OWN_WINDOW_ONLY,
  type ModelsEntry,
  type ModelsFile,
  OWN_WINDOW_ONLY_MESSAGE,
} from "../../../src/shared/models/contract.js";
import { allocPort } from "../../helpers/alloc-port.js";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

/**
 * The dark half of `own-window-routes.test.ts` (#2404 R1, #1123): the real
 * server (`startMcpServerHttp`) with the feature off. It takes no
 * `localModelSettingsEnabled`, so the registrar's default — the flag, forced
 * false by this file's mock — is the guard pinned here:
 * `deps.localModelSettingsEnabled ?? BYO_MODELS_ENABLED` in
 * `src/server/models/api-routes.ts`, and the `!live` 404 in both settings
 * handlers. The origin test still runs first, so a foreign origin is 403.
 */

const localModel: ModelsEntry = {
  id: "m-1",
  provider: "local-ollama",
  displayName: "Local",
  modelId: "qwen2.5:14b-instruct",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};
const fileWith = (...models: ModelsEntry[]): ModelsFile => ({
  schemaVersion: 1,
  models,
  defaultModelId: null,
});

interface Answer {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

interface SendOpts {
  method?: "GET" | "POST";
  /** Omitted → no Origin header at all. */
  origin?: string;
  contentType?: string;
  body?: string;
}

function send(port: number, urlPath: string, opts: SendOpts = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: urlPath, method: opts.method ?? "POST", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const JSON_CT = "application/json";
const modelsBody = (file: ModelsFile, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ file, ifMatch: getModelsEtag(), ...extra });

function expectOwnWindowRefusal(res: Answer): void {
  expect(res.status).toBe(403);
  expect(res.json).toEqual({
    error: "FORBIDDEN",
    code: ERROR_CODE_OWN_WINDOW_ONLY,
    message: OWN_WINDOW_ONLY_MESSAGE,
  });
}

/** The bytes of a file, or null when it does not exist. */
function bytes(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

describe("the real server, dark: the settings routes (#2404 R1, #1123)", () => {
  let dir: string;
  let server: Server | undefined;
  let port: number;
  let own: string;

  async function boot(): Promise<void> {
    vi.stubEnv("TANDEM_MODELS_DEV_ORIGIN", undefined as never);
    port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
    own = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-own-window-dark-"));
    __resetModelRegistryForTests(dir);
    __resetLocalModelSettingsForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await close(server);
    server = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await __flushLocalModelAnnouncedForTests();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
  });

  it("the anchor: the file-level mock applied, so the flag reads false here", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  describe("dark: both halves of each route", () => {
    it("POST /api/models/local-settings: 404 from an accepted origin, 403 from any other, and no file", async () => {
      await boot();
      for (const editing of [true, false]) {
        const mine = await send(port, API_MODELS_LOCAL_SETTINGS, {
          origin: own,
          contentType: JSON_CT,
          body: JSON.stringify({ editing }),
        });
        expect(mine.status).toBe(404);
        expectOwnWindowRefusal(
          await send(port, API_MODELS_LOCAL_SETTINGS, {
            origin: "http://127.0.0.1:8080",
            contentType: JSON_CT,
            body: JSON.stringify({ editing }),
          }),
        );
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("POST /api/models: written from an accepted origin (the dark reconcile), refused from any other, and only models.json exists", async () => {
      await boot();
      expectOwnWindowRefusal(
        await send(port, API_MODELS, {
          origin: "http://127.0.0.1:8080",
          contentType: JSON_CT,
          body: modelsBody(fileWith(localModel), { reconcile: true }),
        }),
      );
      expect(fs.readdirSync(dir)).toEqual([]);

      const mine = await send(port, API_MODELS, {
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel), { reconcile: true }),
      });
      expect(mine.status, mine.text).toBe(200);
      // No settings file, no record of what the user was told, no marker.
      expect(fs.readdirSync(dir)).toEqual([MODELS_FILE_NAME]);
      expect(bytes(path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME))).toBeNull();
      expect(bytes(path.join(dir, "local-model-baseline.json"))).toBeNull();
    });
  });

  it("GET /api/models answers a foreign loopback port and a request with no Origin exactly as before while dark (#1123 item 31: the own-window read test is lit only)", async () => {
    await boot();
    const seeded = await send(port, API_MODELS, {
      origin: own,
      contentType: JSON_CT,
      body: modelsBody(fileWith(localModel), { reconcile: true }),
    });
    expect(seeded.status, seeded.text).toBe(200);
    for (const origin of ["http://127.0.0.1:8080", undefined]) {
      const res = await send(port, API_MODELS, { method: "GET", origin });
      expect(res.status).toBe(200);
      // The bytes master sends: the full file (endpoint included) and its etag.
      expect(res.text).toBe(JSON.stringify({ file: getCachedModelsFile(), etag: getModelsEtag() }));
      expect(res.text).toContain(localModel.endpoint as string);
    }
  });

  it("GET /api/models/local-settings is still 404 while dark, for any origin", async () => {
    await boot();
    for (const origin of ["http://127.0.0.1:8080", own, undefined]) {
      const res = await send(port, API_MODELS_LOCAL_SETTINGS, { method: "GET", origin });
      expect(res.status).toBe(404);
    }
  });
});
