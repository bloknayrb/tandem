import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
  type KeychainBackend,
} from "../../../src/server/integrations/keychain.js";
import { apiMiddleware } from "../../../src/server/mcp/api-routes.js";
import { startMcpServerHttp } from "../../../src/server/mcp/server.js";
import { registerModelsRoutes } from "../../../src/server/models/api-routes.js";
import {
  __flushLocalModelAnnouncedForTests,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  isLocalModelEditingEnabled,
  LOCAL_MODEL_SETTINGS_FILE_NAME,
} from "../../../src/server/models/local-model-settings.js";
import { type BoundAddress, createOwnWindowPolicy } from "../../../src/server/models/own-window.js";
import {
  __resetModelRegistryForTests,
  getCachedModelsFile,
  getModelsEtag,
} from "../../../src/server/models/registry.js";
import { MODELS_FILE_NAME } from "../../../src/server/models/store.js";
import {
  BYO_MODELS_ENABLED,
  TAURI_HOSTNAME,
  TAURI_LINUX_ORIGIN,
} from "../../../src/shared/constants.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  ERROR_CODE_OWN_WINDOW_ONLY,
  MODELS_DEV_ORIGIN_ENV,
  type ModelsEntry,
  type ModelsFile,
  OWN_WINDOW_ONLY_MESSAGE,
} from "../../../src/shared/models/contract.js";
import { allocPort } from "../../helpers/alloc-port.js";

/**
 * Only Tandem's own window can change the local-model settings (#2404, R1).
 *
 * `POST /api/models` and `POST /api/models/local-settings` accept a request
 * only when the browser-set `Origin` is exactly one of Tandem's own page
 * origins. Every refusal here asserts the refusal itself (the code and the
 * sentence) and the BYTES of the files, not only a status.
 *
 * Two harnesses:
 *  - the real server (`startMcpServerHttp`), where the feature is dark: the
 *    whole chain including the pre-parse router, the Host checks and the
 *    development allowance read from the environment;
 *  - `registerModelsRoutes` with the real `apiMiddleware`, where the settings
 *    route can be lit.
 *
 * Requests go through `node:http`, so `Host`, `Origin` and `Content-Type` are
 * exactly what the case says and nothing more.
 */

const E2E_VITE_ORIGIN = "http://127.0.0.1:4573";
const VITE_DEV_ORIGIN = "http://127.0.0.1:5173";

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
  headers: Record<string, string | string[] | undefined>;
}

interface SendOpts {
  method?: "GET" | "POST" | "DELETE";
  /** Omitted → no Origin header at all. */
  origin?: string;
  /** Omitted → the real `127.0.0.1:<port>`. */
  host?: string;
  contentType?: string;
  body?: string;
}

function send(port: number, urlPath: string, opts: SendOpts = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
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
          resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
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
  expect(ERROR_CODE_OWN_WINDOW_ONLY).toBe("OWN_WINDOW_ONLY");
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

const memoryBackend = (): KeychainBackend => {
  const map = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  return {
    get: (service, account) => map.get(key(service, account)) ?? null,
    set: (service, account, value) => {
      map.set(key(service, account), value);
    },
    delete: (service, account) => map.delete(key(service, account)),
  };
};

/** Remove a temp dir once the record writes a test left queued have settled. */
async function removeDir(dir: string): Promise<void> {
  await __flushLocalModelAnnouncedForTests();
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// ── The real server (the feature is dark here) ────────────────────────────────

describe("the real server: the two settings POSTs accept Tandem's own window only (#2404 R1)", () => {
  let dir: string;
  let modelsFile: string;
  let settingsFile: string;
  let server: Server;
  let port: number;
  let own: string;

  async function boot(devOrigin?: string): Promise<void> {
    if (devOrigin === undefined) vi.stubEnv("TANDEM_MODELS_DEV_ORIGIN", undefined as never);
    else vi.stubEnv("TANDEM_MODELS_DEV_ORIGIN", devOrigin);
    port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
    own = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-own-window-real-"));
    modelsFile = path.join(dir, MODELS_FILE_NAME);
    settingsFile = path.join(dir, LOCAL_MODEL_SETTINGS_FILE_NAME);
    __resetModelRegistryForTests(dir);
    __resetLocalModelSettingsForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await close(server);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await removeDir(dir);
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
  });

  it("this suite runs against a dark build", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  describe("accepted", () => {
    it.each([
      ["the page this server serves", () => own],
      ["the desktop WebView on Windows", () => `http://${TAURI_HOSTNAME}`],
      ["the desktop WebView over https", () => `https://${TAURI_HOSTNAME}`],
      ["the desktop WebView on macOS and Linux", () => TAURI_LINUX_ORIGIN],
    ])("POST /api/models from %s is written", async (_label, origin) => {
      await boot();
      const res = await send(port, API_MODELS, {
        origin: origin(),
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ etag: getModelsEtag() });
      expect(getCachedModelsFile().models).toEqual([localModel]);
      expect(JSON.parse(bytes(modelsFile) as string).models).toEqual([localModel]);
    });

    it.each([
      ["the page this server serves", () => own],
      ["the desktop WebView on Windows", () => `http://${TAURI_HOSTNAME}`],
      ["the desktop WebView over https", () => `https://${TAURI_HOSTNAME}`],
      ["the desktop WebView on macOS and Linux", () => TAURI_LINUX_ORIGIN],
    ])(
      "POST /api/models/local-settings from %s passes the origin test (and is 404 while dark)",
      async (_label, origin) => {
        await boot();
        const res = await send(port, API_MODELS_LOCAL_SETTINGS, {
          origin: origin(),
          contentType: JSON_CT,
          body: JSON.stringify({ editing: true }),
        });
        expect(res.status).toBe(404);
        expect(res.json).toEqual({ error: "NOT_FOUND" });
        expect(bytes(settingsFile)).toBeNull();
      },
    );

    it("the reconcile action's request ({ file, ifMatch, reconcile: true }) is written", async () => {
      await boot();
      const res = await send(port, API_MODELS, {
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel), { reconcile: true }),
      });
      expect(res.status, res.text).toBe(200);
      expect(getCachedModelsFile().models).toEqual([localModel]);
    });
  });

  describe("refused, with nothing written", () => {
    const FOREIGN: Array<[string, (p: number) => string | undefined]> = [
      ["another loopback port", (p) => `http://127.0.0.1:${p + 1}`],
      ["the Vite dev origin with the variable unset", () => VITE_DEV_ORIGIN],
      ["the E2E client origin with the variable unset", () => E2E_VITE_ORIGIN],
      ["localhost on the bound port", (p) => `http://localhost:${p}`],
      ["tauri.localhost on port 8080", () => `http://${TAURI_HOSTNAME}:8080`],
      ["tauri.localhost on the bound port", (p) => `http://${TAURI_HOSTNAME}:${p}`],
      ["https on the bound port", (p) => `https://127.0.0.1:${p}`],
      ["the opaque origin null", () => "null"],
      ["a missing Origin", () => undefined],
      ["a site on the internet", () => "https://evil.example"],
    ];

    it.each(FOREIGN)("POST /api/models from %s", async (_label, origin) => {
      await boot();
      // A file already there: a refusal must leave its bytes alone.
      const seed = await send(port, API_MODELS, {
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      expect(seed.status).toBe(200);
      const before = bytes(modelsFile);
      const etag = getModelsEtag();
      expect(before).not.toBeNull();

      const res = await send(port, API_MODELS, {
        origin: origin(port),
        contentType: JSON_CT,
        body: modelsBody(fileWith({ ...localModel, endpoint: "http://127.0.0.1:9999" })),
      });
      expectOwnWindowRefusal(res);
      expect(bytes(modelsFile)).toBe(before);
      expect(getModelsEtag()).toBe(etag);
      expect(getCachedModelsFile().models).toEqual([localModel]);
    });

    it.each(FOREIGN)(
      "POST /api/models/local-settings from %s (403 now, where a foreign loopback port used to get 404)",
      async (_label, origin) => {
        await boot();
        for (const editing of [true, false]) {
          const res = await send(port, API_MODELS_LOCAL_SETTINGS, {
            origin: origin(port),
            contentType: JSON_CT,
            body: JSON.stringify({ editing }),
          });
          expectOwnWindowRefusal(res);
        }
        expect(bytes(settingsFile)).toBeNull();
        expect(isLocalModelEditingEnabled()).toBe(false);
      },
    );

    it("a forged Host with a matching Origin is refused by the Host check, before the origin test", async () => {
      await boot();
      for (const url of [API_MODELS, API_MODELS_LOCAL_SETTINGS]) {
        const res = await send(port, url, {
          host: `evil.example:${port}`,
          origin: `http://evil.example:${port}`,
          contentType: JSON_CT,
          body: url === API_MODELS ? modelsBody(fileWith(localModel)) : '{"editing":true}',
        });
        expect(res.status).toBe(403);
        // The Host allowlist answered, not the own-window test: a rebound host
        // never reaches it.
        expect(res.json?.code).not.toBe(ERROR_CODE_OWN_WINDOW_ONLY);
        expect(res.text).toMatch(/host/i);
      }
      expect(bytes(modelsFile)).toBeNull();
      expect(bytes(settingsFile)).toBeNull();
    });

    it("a forged Host cannot pass by presenting Tandem's own Origin either", async () => {
      await boot();
      const res = await send(port, API_MODELS, {
        host: `evil.example:${port}`,
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      expect(res.status).toBe(403);
      expect(bytes(modelsFile)).toBeNull();
    });

    it("echoing the Host back as the Origin never passes: tauri.localhost with the bound port", async () => {
      await boot();
      const res = await send(port, API_MODELS, {
        host: `${TAURI_HOSTNAME}:${port}`,
        origin: `http://${TAURI_HOSTNAME}:${port}`,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      // Whichever layer answers first (the SDK's Host check refuses this Host
      // on a loopback bind), it is a refusal and nothing is written.
      expect(res.status).toBe(403);
      expect(bytes(modelsFile)).toBeNull();
      expect(getCachedModelsFile().models).toEqual([]);
    });

    it("a text/plain POST with no body from a foreign origin is refused", async () => {
      await boot();
      for (const url of [API_MODELS, API_MODELS_LOCAL_SETTINGS]) {
        expectOwnWindowRefusal(
          await send(port, url, { origin: "http://127.0.0.1:8080", contentType: "text/plain" }),
        );
        expectOwnWindowRefusal(await send(port, url, { contentType: "text/plain" }));
      }
      expect(bytes(modelsFile)).toBeNull();
      expect(bytes(settingsFile)).toBeNull();
    });

    it("a text/plain POST with no body from Tandem's own page writes nothing: 400 for models", async () => {
      await boot();
      const res = await send(port, API_MODELS, { origin: own, contentType: "text/plain" });
      expect(res.status).toBe(400);
      expect(res.json?.code).not.toBe(ERROR_CODE_OWN_WINDOW_ONLY);
      const withText = await send(port, API_MODELS, {
        origin: own,
        contentType: "text/plain",
        body: modelsBody(fileWith(localModel)),
      });
      expect(withText.status).toBe(400);
      expect(bytes(modelsFile)).toBeNull();
      expect(getCachedModelsFile().models).toEqual([]);
    });
  });

  describe("the origin is decided before the body is read", () => {
    const OVERSIZE = JSON.stringify({ file: { pad: "x".repeat(150_000) }, ifMatch: "" });
    const MALFORMED = '{"file": ';

    it.each([API_MODELS, API_MODELS_LOCAL_SETTINGS])(
      "%s: an over-limit body from a foreign origin is 403 OWN_WINDOW_ONLY, not 413",
      async (url) => {
        await boot();
        expect(OVERSIZE.length).toBeGreaterThan(100_000);
        expectOwnWindowRefusal(
          await send(port, url, {
            origin: "http://127.0.0.1:8080",
            contentType: JSON_CT,
            body: OVERSIZE,
          }),
        );
        // …and it is the size limit that answers Tandem's own page.
        const mine = await send(port, url, { origin: own, contentType: JSON_CT, body: OVERSIZE });
        expect(mine.status).toBe(413);
      },
    );

    it.each([API_MODELS, API_MODELS_LOCAL_SETTINGS])(
      "%s: a malformed JSON body from a foreign origin is 403 OWN_WINDOW_ONLY, not 400",
      async (url) => {
        await boot();
        expectOwnWindowRefusal(
          await send(port, url, {
            origin: "http://127.0.0.1:8080",
            contentType: JSON_CT,
            body: MALFORMED,
          }),
        );
        const mine = await send(port, url, { origin: own, contentType: JSON_CT, body: MALFORMED });
        expect(mine.status).toBe(400);
        expect(bytes(modelsFile)).toBeNull();
      },
    );
  });

  describe("the development allowance (TANDEM_MODELS_DEV_ORIGIN)", () => {
    it("set to the Vite dev origin: exactly that origin is admitted, and Tandem's own still are", async () => {
      await boot(VITE_DEV_ORIGIN);
      const res = await send(port, API_MODELS, {
        origin: VITE_DEV_ORIGIN,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      expect(res.status, res.text).toBe(200);
      expect(getCachedModelsFile().models).toEqual([localModel]);
      const before = bytes(modelsFile);

      for (const origin of [
        "http://127.0.0.1:5174",
        "http://127.0.0.1:51730",
        "http://127.0.0.1:517",
        "http://localhost:5173",
        "https://127.0.0.1:5173",
        `${VITE_DEV_ORIGIN}/`,
        E2E_VITE_ORIGIN,
      ]) {
        expectOwnWindowRefusal(
          await send(port, API_MODELS, {
            origin,
            contentType: JSON_CT,
            body: modelsBody(fileWith()),
          }),
        );
        expectOwnWindowRefusal(
          await send(port, API_MODELS_LOCAL_SETTINGS, {
            origin,
            contentType: JSON_CT,
            body: '{"editing":true}',
          }),
        );
      }
      expect(bytes(modelsFile)).toBe(before);

      const mine = await send(port, API_MODELS, {
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith()),
      });
      expect(mine.status).toBe(200);
      // The settings route passes the origin test for the allowance origin too.
      const settings = await send(port, API_MODELS_LOCAL_SETTINGS, {
        origin: VITE_DEV_ORIGIN,
        contentType: JSON_CT,
        body: '{"editing":true}',
      });
      expect(settings.status).toBe(404);
    });

    it("logs one line at boot when the allowance is active", async () => {
      await boot(VITE_DEV_ORIGIN);
      const lines = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.includes(MODELS_DEV_ORIGIN_ENV));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(VITE_DEV_ORIGIN);
    });

    it("unset: nothing about it is logged", async () => {
      await boot();
      const lines = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.includes(MODELS_DEV_ORIGIN_ENV));
      expect(lines).toEqual([]);
    });

    it.each([
      "*",
      "null",
      "",
      "http://127.0.0.1:5173,http://127.0.0.1:5174",
      "http://127.0.0.1:5000-6000",
      "http://127.0.0.1:",
      "http://127.0.0.1",
      "http://localhost:5173",
      "http://192.168.1.5:5173",
      "http://127.0.0.1:5173/",
    ])(
      "a malformed value (%j) boots the server, is logged as refused, and admits nothing extra",
      async (value) => {
        await boot(value);
        const lines = vi
          .mocked(console.error)
          .mock.calls.map((c) => String(c[0]))
          .filter((l) => l.includes(MODELS_DEV_ORIGIN_ENV));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/NOT active/);

        for (const origin of [
          VITE_DEV_ORIGIN,
          "http://127.0.0.1:5174",
          "http://127.0.0.1:5000",
          "http://localhost:5173",
          "http://192.168.1.5:5173",
          "null",
          value,
        ]) {
          if (origin === "") continue;
          expectOwnWindowRefusal(
            await send(port, API_MODELS, {
              origin,
              contentType: JSON_CT,
              body: modelsBody(fileWith(localModel)),
            }),
          );
        }
        expect(bytes(modelsFile)).toBeNull();
        // Tandem's own window is unaffected by a bad value.
        const mine = await send(port, API_MODELS, {
          origin: own,
          contentType: JSON_CT,
          body: modelsBody(fileWith(localModel)),
        });
        expect(mine.status).toBe(200);
      },
    );
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

  describe("reads are unchanged (R1.3)", () => {
    it.each([
      ["a foreign loopback port", "http://127.0.0.1:8080"],
      ["no Origin at all", undefined],
    ])("GET /api/models answers the file and its etag for %s", async (_label, origin) => {
      await boot();
      await send(port, API_MODELS, {
        origin: own,
        contentType: JSON_CT,
        body: modelsBody(fileWith(localModel)),
      });
      const res = await send(port, API_MODELS, { method: "GET", origin });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ file: getCachedModelsFile(), etag: getModelsEtag() });
    });

    it("GET /api/models/local-settings is still 404 while dark, for any origin", async () => {
      await boot();
      for (const origin of ["http://127.0.0.1:8080", own, undefined]) {
        const res = await send(port, API_MODELS_LOCAL_SETTINGS, { method: "GET", origin });
        expect(res.status).toBe(404);
      }
    });
  });
});

// ── registerModelsRoutes with the real middleware (the settings route lit) ────

describe("registerModelsRoutes, lit, with the real apiMiddleware (#2404 R1)", () => {
  let dir: string;
  let modelsFile: string;
  let settingsFile: string;
  let server: Server;
  let port: number;
  let own: string;
  let backend: KeychainBackend;

  async function boot(opts: { live?: boolean; allowance?: string } = {}): Promise<void> {
    let bound: BoundAddress | null = null;
    const app: Express = express();
    app.use(express.json());
    backend = memoryBackend();
    registerModelsRoutes(app, (_req, _res, next) => next(), apiMiddleware, {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend }),
      ownWindow: createOwnWindowPolicy({
        getBound: () => bound,
        allowance: opts.allowance ?? null,
      }),
      ...(opts.live === false ? {} : { localModelSettingsEnabled: true }),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    bound = { address: addr.address, port: addr.port };
    port = addr.port;
    own = `http://127.0.0.1:${port}`;
  }

  const postSetting = (origin: string | undefined, editing: boolean) =>
    send(port, API_MODELS_LOCAL_SETTINGS, {
      origin,
      contentType: JSON_CT,
      body: JSON.stringify({ editing }),
    });

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-own-window-lit-"));
    modelsFile = path.join(dir, MODELS_FILE_NAME);
    settingsFile = path.join(dir, LOCAL_MODEL_SETTINGS_FILE_NAME);
    __resetModelRegistryForTests(dir);
    __resetLocalModelSettingsForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await close(server);
    vi.restoreAllMocks();
    await removeDir(dir);
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
  });

  it.each([
    ["the page this server serves", () => own],
    ["the desktop WebView on Windows", () => `http://${TAURI_HOSTNAME}`],
    ["the desktop WebView over https", () => `https://${TAURI_HOSTNAME}`],
    ["the desktop WebView on macOS and Linux", () => TAURI_LINUX_ORIGIN],
  ])("On and then Off from %s are both taken and written", async (_label, origin) => {
    await boot();
    const on = await postSetting(origin(), true);
    expect(on.status, on.text).toBe(200);
    expect(on.json).toEqual({ editing: true, persisted: true });
    expect(JSON.parse(bytes(settingsFile) as string)).toEqual({ version: 1, editing: true });

    const off = await postSetting(origin(), false);
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ editing: false, persisted: true });
    expect(isLocalModelEditingEnabled()).toBe(false);
  });

  it.each([
    ["another loopback port", (p: number) => `http://127.0.0.1:${p + 1}`],
    ["an allowlisted loopback port (8080)", () => "http://127.0.0.1:8080"],
    ["the Vite dev origin", () => VITE_DEV_ORIGIN],
    ["localhost on the bound port", (p: number) => `http://localhost:${p}`],
    ["tauri.localhost on port 8080", () => `http://${TAURI_HOSTNAME}:8080`],
    ["the opaque origin null", () => "null"],
    ["a missing Origin", () => undefined],
  ])("On from %s is refused: still off, no file", async (_label, origin) => {
    await boot();
    expectOwnWindowRefusal(await postSetting(origin(port), true));
    expect(isLocalModelEditingEnabled()).toBe(false);
    expect(bytes(settingsFile)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["an allowlisted loopback port (8080)", () => "http://127.0.0.1:8080"],
    ["tauri.localhost on port 8080", () => `http://${TAURI_HOSTNAME}:8080`],
    ["the opaque origin null", () => "null"],
    ["a missing Origin", () => undefined],
  ])(
    "Off follows the same rule as On: Off from %s is refused, and it stays on",
    async (_label, origin) => {
      await boot();
      expect((await postSetting(own, true)).status).toBe(200);
      const before = bytes(settingsFile);
      expect(before).not.toBeNull();

      expectOwnWindowRefusal(await postSetting(origin(), false));
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(bytes(settingsFile)).toBe(before);
    },
  );

  it("a text/plain POST with no body from Tandem's own page is 400 and writes nothing", async () => {
    await boot();
    const res = await send(port, API_MODELS_LOCAL_SETTINGS, {
      origin: own,
      contentType: "text/plain",
    });
    expect(res.status).toBe(400);
    expect(res.json?.code).not.toBe(ERROR_CODE_OWN_WINDOW_ONLY);
    expect(bytes(settingsFile)).toBeNull();
    expect(isLocalModelEditingEnabled()).toBe(false);
  });

  it("the allowance admits exactly its origin on the settings route, and nothing near it", async () => {
    await boot({ allowance: VITE_DEV_ORIGIN });
    for (const origin of ["http://127.0.0.1:5174", "http://127.0.0.1:51730", E2E_VITE_ORIGIN]) {
      expectOwnWindowRefusal(await postSetting(origin, true));
    }
    expect(isLocalModelEditingEnabled()).toBe(false);
    const res = await postSetting(VITE_DEV_ORIGIN, true);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ editing: true, persisted: true });
  });

  it("with no allowance the Vite dev and E2E origins are refused on both routes", async () => {
    await boot();
    for (const origin of [VITE_DEV_ORIGIN, E2E_VITE_ORIGIN]) {
      expectOwnWindowRefusal(await postSetting(origin, true));
      expectOwnWindowRefusal(
        await send(port, API_MODELS, {
          origin,
          contentType: JSON_CT,
          body: modelsBody(fileWith(localModel)),
        }),
      );
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("the refusal is readable by an allowlisted foreign origin and carries no grant for any other (Critical Rule 8)", async () => {
    await boot();
    const dev = await postSetting(VITE_DEV_ORIGIN, true);
    expectOwnWindowRefusal(dev);
    // The shared CORS allowlist still lets a 127.0.0.1 page READ the refusal,
    // which is how the dev client learns why.
    expect(dev.headers["access-control-allow-origin"]).toBe(VITE_DEV_ORIGIN);
    for (const origin of ["null", "https://evil.example", `http://localhost:${port}`]) {
      const res = await postSetting(origin, true);
      expectOwnWindowRefusal(res);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("dark through the registrar: 404 from an accepted origin, 403 from another, nothing read or written", async () => {
    await boot({ live: false });
    fs.writeFileSync(settingsFile, '{"version":1,"editing":true}\n', "utf8");
    const before = bytes(settingsFile);
    expect((await postSetting(own, false)).status).toBe(404);
    expectOwnWindowRefusal(await postSetting("http://127.0.0.1:8080", false));
    expect(bytes(settingsFile)).toBe(before);
    expect(isLocalModelEditingEnabled()).toBe(false);
  });

  it("reads are unchanged: both GETs answer a foreign allowlisted origin, and one with no Origin", async () => {
    await boot();
    await postSetting(own, true);
    for (const origin of ["http://127.0.0.1:8080", undefined]) {
      const settings = await send(port, API_MODELS_LOCAL_SETTINGS, { method: "GET", origin });
      expect(settings.status).toBe(200);
      expect(settings.json).toEqual({ editing: true });
      const models = await send(port, API_MODELS, { method: "GET", origin });
      expect(models.status).toBe(200);
      expect(models.json).toEqual({ file: getCachedModelsFile(), etag: getModelsEtag() });
    }
  });

  it("POST /api/models/secrets/:ref is NOT covered: another loopback port can still store and delete a key", async () => {
    await boot();
    const foreign = "http://127.0.0.1:8080";
    const stored = await send(port, "/api/models/secrets/ref-1", {
      origin: foreign,
      contentType: JSON_CT,
      body: JSON.stringify({ secret: "sk-test" }),
    });
    expect(stored.status).toBe(204);
    expect(backend.get(KEYCHAIN_SERVICE_MODELS, "ref-1")).toBe("sk-test");
    const removed = await send(port, "/api/models/secrets/ref-1", {
      method: "DELETE",
      origin: foreign,
    });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ existed: true });
    // …and it changes neither which model answers nor the commenting opt-in.
    expect(bytes(modelsFile)).toBeNull();
    expect(bytes(settingsFile)).toBeNull();
  });
});

// A real ::1 listener is not attempted here (a CI runner may have no IPv6); the
// bound-address rule is pinned on the policy in own-window.test.ts.
describe("the bound port is the one actually listened on (#2404)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    vi.stubEnv("TANDEM_MODELS_DEV_ORIGIN", undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
  });

  afterAll(async () => {
    await close(server);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("http://127.0.0.1:0 and a bare http://127.0.0.1 are never Tandem's own origin", async () => {
    for (const origin of ["http://127.0.0.1:0", "http://127.0.0.1", "http://127.0.0.1:80"]) {
      expectOwnWindowRefusal(
        await send(port, API_MODELS_LOCAL_SETTINGS, {
          origin,
          contentType: JSON_CT,
          body: '{"editing":true}',
        }),
      );
    }
  });
});
