import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetModelsReconcileGuardForTests,
  MODELS_RECONCILED_FLAG_KEY,
  reconcileModelsToServerOnce,
} from "../../../src/client/actions/reconcile-models-registry.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/client/hooks/useTandemSettings.js";
import { API_BASE } from "../../../src/client/utils/fileUpload.js";
import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
} from "../../../src/server/integrations/keychain.js";
import { apiMiddleware } from "../../../src/server/mcp/api-routes.js";
import {
  type ModelsRoutesDeps,
  registerModelsRoutes,
} from "../../../src/server/models/api-routes.js";
import {
  __resetLocalModelSettingsForTests,
  isLocalModelEditingEnabled,
  LOCAL_MODEL_SETTINGS_FILE_NAME,
  localModelEditingState,
  primeLocalModelSettings,
} from "../../../src/server/models/local-model-settings.js";
import {
  __resetModelRegistryForTests,
  getCachedModelsFile,
  getModelsEtag,
} from "../../../src/server/models/registry.js";
import { MODELS_FILE_NAME } from "../../../src/server/models/store.js";
import {
  BYO_MODELS_ENABLED,
  TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV,
  TANDEM_SETTINGS_KEY,
  TAURI_HOSTNAME,
} from "../../../src/shared/constants.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  ERROR_CODE_INVALID_LOCAL_MODEL_SETTINGS,
  ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED,
  type ModelsEntry,
  type ModelsFile,
} from "../../../src/shared/models/contract.js";
import { readRegistrar } from "../../helpers/api-route-source.js";
import { withEnvOverride } from "../../helpers/env-override.js";
import { installLocalStorageStub } from "../../helpers/local-storage-stub.js";

/**
 * `OPTIONS/GET/POST /api/models/local-settings` (#1123) on a real express app,
 * mounted the way `tests/server/models/api-routes.test.ts` mounts the registrar.
 *
 * A settings write is failed by replacing `atomicWriteConfigFile` for the
 * settings file only — never by file permissions — so the cases mean the same
 * thing on Windows and POSIX. `models.json` writes reach the real helper.
 */
const writeControl = vi.hoisted(() => ({ failSettingsWrites: false }));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
      if (writeControl.failSettingsWrites && file.endsWith("local-model-settings.json")) {
        throw new Error("simulated write failure");
      }
      return actual.atomicWriteConfigFile(file, content);
    },
  };
});

const ALLOWED_ORIGIN = `http://${TAURI_HOSTNAME}`;
const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

const deps = (over: Partial<ModelsRoutesDeps> = {}): ModelsRoutesDeps => ({
  keychain: createKeychain({
    service: KEYCHAIN_SERVICE_MODELS,
    backend: { get: () => null, set: () => {}, delete: () => false },
  }),
  ...over,
});

interface AppOpts {
  /** Omitted → the registrar's own default (the dark flag). */
  live?: boolean;
  mw?: typeof passthrough;
  /** Present → every request appears to come from this socket address. */
  remoteAddress?: string;
}

function makeApp(opts: AppOpts = {}): Express {
  const app = express();
  app.use(express.json());
  if (opts.remoteAddress !== undefined) {
    const addr = opts.remoteAddress;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: addr, configurable: true });
      next();
    });
  }
  registerModelsRoutes(
    app,
    passthrough,
    opts.mw ?? passthrough,
    deps(opts.live === undefined ? {} : { localModelSettingsEnabled: opts.live }),
  );
  return app;
}

const servers: Server[] = [];

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** `origin: null` sends no Origin header at all (Node `fetch` adds none). */
async function call(
  base: string,
  method: "GET" | "POST" | "OPTIONS",
  url: string,
  opts: {
    json?: unknown;
    raw?: { contentType: string; text: string };
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.Origin = opts.origin ?? ALLOWED_ORIGIN;
  let body: string | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.raw.contentType;
    body = opts.raw.text;
  } else if ("json" in opts) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${base}${url}`, { method, headers, body });
  const ct = res.headers.get("content-type") ?? "";
  const payload = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  return { status: res.status, body: payload, headers: res.headers };
}

const localModel: ModelsEntry = {
  id: "m-1",
  provider: "local-ollama",
  displayName: "Local",
  modelId: "qwen2.5:14b-instruct",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

describe(`${API_MODELS_LOCAL_SETTINGS} (#1123)`, () => {
  let dir: string;
  let settingsFile: string;
  let modelsFile: string;

  const getSetting = (base: string) => call(base, "GET", API_MODELS_LOCAL_SETTINGS);
  const postSetting = (base: string, json: unknown) =>
    call(base, "POST", API_MODELS_LOCAL_SETTINGS, { json });
  const postModels = (base: string, file: ModelsFile) =>
    call(base, "POST", API_MODELS, { json: { file, ifMatch: getModelsEtag() } });

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-local-settings-route-"));
    settingsFile = path.join(dir, LOCAL_MODEL_SETTINGS_FILE_NAME);
    modelsFile = path.join(dir, MODELS_FILE_NAME);
    __resetLocalModelSettingsForTests(dir);
    __resetModelRegistryForTests(dir);
    writeControl.failSettingsWrites = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
    writeControl.failSettingsWrites = false;
    __resetLocalModelSettingsForTests();
    __resetModelRegistryForTests();
    _resetModelsReconcileGuardForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  describe("GET and POST, lit", () => {
    it("GET answers { editing: false }, then { editing: true } after a POST", async () => {
      const base = await listen(makeApp({ live: true }));

      const first = await getSetting(base);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ editing: false });

      const post = await postSetting(base, { editing: true });
      expect(post.status).toBe(200);
      expect(post.body).toEqual({ editing: true, persisted: true });

      const second = await getSetting(base);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ editing: true });
      expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toEqual({
        version: 1,
        editing: true,
      });
    });

    it("POST { editing: false } switches it back off and bumps offEpoch", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      const epoch = localModelEditingState().offEpoch;

      const post = await postSetting(base, { editing: false });
      expect(post.status).toBe(200);
      expect(post.body).toEqual({ editing: false, persisted: true });
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: epoch + 1 });
      expect((await getSetting(base)).body).toEqual({ editing: false });
    });

    it("GET needs no Origin and writes nothing", async () => {
      const base = await listen(makeApp({ live: true }));
      const res = await call(base, "GET", API_MODELS_LOCAL_SETTINGS, { origin: null });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ editing: false });
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("the setting survives a restart of the server process", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });

      __resetLocalModelSettingsForTests(dir);
      primeLocalModelSettings();
      const again = await listen(makeApp({ live: true }));
      expect((await getSetting(again)).body).toEqual({ editing: true });
    });
  });

  describe("POST refusals change nothing", () => {
    /** Run `attempt` from both starting states; neither may move. */
    async function expectNoChange(
      attempt: (base: string) => Promise<Answer>,
      expectStatus: number,
    ): Promise<Answer[]> {
      const base = await listen(makeApp({ live: true }));
      const answers: Answer[] = [];

      // From off: no file may appear.
      answers.push(await attempt(base));
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.existsSync(settingsFile)).toBe(false);

      // From on: it stays on, the file is untouched, and no Off was recorded.
      await postSetting(base, { editing: true });
      const bytes = fs.readFileSync(settingsFile);
      const state = localModelEditingState();
      answers.push(await attempt(base));
      expect(localModelEditingState()).toEqual(state);
      expect(fs.readFileSync(settingsFile).equals(bytes)).toBe(true);
      expect((await getSetting(base)).body).toEqual({ editing: true });

      for (const a of answers) expect(a.status).toBe(expectStatus);
      return answers;
    }

    it("a missing Origin → 403 BAD_ORIGIN", async () => {
      const answers = await expectNoChange(
        (base) =>
          call(base, "POST", API_MODELS_LOCAL_SETTINGS, { json: { editing: true }, origin: null }),
        403,
      );
      expect((answers[0].body as { code?: string }).code).toBe("BAD_ORIGIN");
    });

    it.each([
      "https://evil.example",
      "http://localhost:5173",
      "null",
      "http://127.0.0.1.evil.example",
    ])("a foreign Origin (%s) → 403 BAD_ORIGIN", async (origin) => {
      const answers = await expectNoChange(
        (base) =>
          call(base, "POST", API_MODELS_LOCAL_SETTINGS, { json: { editing: true }, origin }),
        403,
      );
      expect((answers[0].body as { code?: string }).code).toBe("BAD_ORIGIN");
    });

    it("a foreign Origin cannot switch it OFF either", async () => {
      await expectNoChange(
        (base) =>
          call(base, "POST", API_MODELS_LOCAL_SETTINGS, {
            json: { editing: false },
            origin: "https://evil.example",
          }),
        403,
      );
    });

    it.each([
      ['the string "true"', { editing: "true" }],
      ['the string "false"', { editing: "false" }],
      ["the number 1", { editing: 1 }],
      ["the number 0", { editing: 0 }],
      ["null", { editing: null }],
      ["a missing key", {}],
      ["a wrongly named key", { enabled: true }],
      ["a nested value", { editing: { value: true } }],
      ["an array body", [true]],
    ])("a non-boolean body (%s) → 400", async (_name, json) => {
      const answers = await expectNoChange((base) => postSetting(base, json), 400);
      for (const a of answers) {
        expect((a.body as { code?: string }).code).toBe(ERROR_CODE_INVALID_LOCAL_MODEL_SETTINGS);
      }
    });

    it("a text/plain body (a simple request, no preflight) → 400", async () => {
      await expectNoChange(
        (base) =>
          call(base, "POST", API_MODELS_LOCAL_SETTINGS, {
            raw: { contentType: "text/plain", text: JSON.stringify({ editing: true }) },
          }),
        400,
      );
    });

    it("a text/plain body from a foreign Origin → 403", async () => {
      await expectNoChange(
        (base) =>
          call(base, "POST", API_MODELS_LOCAL_SETTINGS, {
            raw: { contentType: "text/plain", text: JSON.stringify({ editing: true }) },
            origin: "https://evil.example",
          }),
        403,
      );
    });

    it("no body at all → 400", async () => {
      await expectNoChange((base) => call(base, "POST", API_MODELS_LOCAL_SETTINGS), 400);
    });
  });

  describe("non-loopback callers", () => {
    it("a non-loopback GET is refused with 403 and does not disclose the value", async () => {
      const lit = await listen(makeApp({ live: true }));
      await postSetting(lit, { editing: true });

      await withEnvOverride(TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV, "1", async () => {
        const lan = await listen(makeApp({ live: true, remoteAddress: "10.0.0.5" }));
        const res = await getSetting(lan);
        expect(res.status).toBe(403);
        expect(res.body).not.toHaveProperty("editing");
      });
    });

    it("a non-loopback POST is refused with 403 and changes nothing", async () => {
      await withEnvOverride(TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV, "1", async () => {
        const lan = await listen(makeApp({ live: true, remoteAddress: "10.0.0.5" }));
        const res = await postSetting(lan, { editing: true });
        expect(res.status).toBe(403);
        expect(isLocalModelEditingEnabled()).toBe(false);
        expect(fs.existsSync(settingsFile)).toBe(false);
      });
    });
  });

  describe("write failure", () => {
    // The rewrite failed, but the earlier write still says on, so the disk
    // agrees with the effective value: nothing to warn about.
    it("a failed redundant ON → 200, still on and still persisted by the earlier write", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      writeControl.failSettingsWrites = true;

      const res = await postSetting(base, { editing: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ editing: true, persisted: true });
      expect((await getSetting(base)).body).toEqual({ editing: true });
    });

    it("a failed ON from off → 500 carrying the effective editing: false and persisted: false", async () => {
      const base = await listen(makeApp({ live: true }));
      writeControl.failSettingsWrites = true;

      const res = await postSetting(base, { editing: true });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        editing: false,
        persisted: false,
        code: ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED,
      });
      expect((await getSetting(base)).body).toEqual({ editing: false });
      expect(fs.existsSync(settingsFile)).toBe(false);
    });

    it("a failed OFF is still off: the file is removed and the answer says editing: false", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      writeControl.failSettingsWrites = true;

      const res = await postSetting(base, { editing: false });
      expect((res.body as { editing: boolean }).editing).toBe(false);
      expect((await getSetting(base)).body).toEqual({ editing: false });
      expect(fs.existsSync(settingsFile)).toBe(false);
    });

    it("the 500 body names no path", async () => {
      // From off, so the answer really is the 500 (a failed redundant On is a
      // 200, which is what this case used to send).
      const base = await listen(makeApp({ live: true }));
      writeControl.failSettingsWrites = true;
      const res = await postSetting(base, { editing: true });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(path.basename(dir));
      expect(JSON.stringify(res.body)).not.toContain(LOCAL_MODEL_SETTINGS_FILE_NAME);
    });
  });

  describe("a later build's settings file (round 2)", () => {
    const V2 = `${JSON.stringify({ version: 2, editing: true, mode: "ask-first" }, null, 4)}\n`;

    it("GET reads it as off", async () => {
      fs.writeFileSync(settingsFile, V2, "utf8");
      primeLocalModelSettings();
      const base = await listen(makeApp({ live: true }));
      expect((await getSetting(base)).body).toEqual({ editing: false });
    });

    it("POST On → 500 { editing: true, persisted: false, code }: on for this run, file untouched", async () => {
      fs.writeFileSync(settingsFile, V2, "utf8");
      primeLocalModelSettings();
      const before = fs.readFileSync(settingsFile);
      const base = await listen(makeApp({ live: true }));

      const res = await postSetting(base, { editing: true });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        editing: true,
        persisted: false,
        code: ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED,
      });
      expect(JSON.stringify(res.body)).not.toContain(path.basename(dir));

      // It IS on, for this run of the server...
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect((await getSetting(base)).body).toEqual({ editing: true });
      // ...and the later build's file was not written.
      expect(fs.readFileSync(settingsFile).equals(before), "byte-identical").toBe(true);
      expect(fs.readdirSync(dir)).toEqual([LOCAL_MODEL_SETTINGS_FILE_NAME]);

      // A restart of the server process reads the file, which says off to this build.
      __resetLocalModelSettingsForTests(dir);
      primeLocalModelSettings();
      const again = await listen(makeApp({ live: true }));
      expect((await getSetting(again)).body).toEqual({ editing: false });
    });

    it("POST Off → 200, written into the file with its version and unknown keys kept", async () => {
      fs.writeFileSync(settingsFile, V2, "utf8");
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });

      const res = await postSetting(base, { editing: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ editing: false, persisted: true });
      expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toEqual({
        version: 2,
        editing: false,
        mode: "ask-first",
      });
      expect((await getSetting(base)).body).toEqual({ editing: false });
    });
  });

  describe("dark (the flag is false and localModelSettingsEnabled is omitted)", () => {
    it("the flag this default follows is false", () => {
      expect(BYO_MODELS_ENABLED).toBe(false);
    });

    it("GET answers 404", async () => {
      const base = await listen(makeApp());
      const res = await getSetting(base);
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty("editing");
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it.each([true, false])(
      "POST { editing: %s } answers 404, changes nothing and creates no file",
      async (editing) => {
        const base = await listen(makeApp());
        const before = localModelEditingState();
        const res = await postSetting(base, { editing });
        expect(res.status).toBe(404);
        expect(res.body).not.toHaveProperty("editing");
        expect(localModelEditingState()).toEqual(before);
        expect(fs.readdirSync(dir)).toEqual([]);
      },
    );

    it("a dark POST does not read or overwrite a file left by a lit build", async () => {
      fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, editing: true }), "utf8");
      const bytes = fs.readFileSync(settingsFile);
      const base = await listen(makeApp());
      expect((await postSetting(base, { editing: false })).status).toBe(404);
      expect((await getSetting(base)).status).toBe(404);
      expect(fs.readFileSync(settingsFile).equals(bytes)).toBe(true);
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("localModelSettingsEnabled: false is dark too", async () => {
      const base = await listen(makeApp({ live: false }));
      expect((await getSetting(base)).status).toBe(404);
      expect((await postSetting(base, { editing: true })).status).toBe(404);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("a dark POST still refuses a foreign Origin before answering 404", async () => {
      const base = await listen(makeApp());
      const res = await call(base, "POST", API_MODELS_LOCAL_SETTINGS, {
        json: { editing: true },
        origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("the setting and the Models registry do not touch each other", () => {
    const fileOf = (models: ModelsEntry[], defaultModelId: string | null): ModelsFile => ({
      schemaVersion: 1,
      models,
      defaultModelId,
    });

    it("Models writes (add, edit, default change, empty registry) leave the setting on and its file byte-identical", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      const bytes = fs.readFileSync(settingsFile);
      const state = localModelEditingState();

      const second: ModelsEntry = { ...localModel, id: "m-2", displayName: "Second" };
      const writes: [string, ModelsFile][] = [
        ["a model added", fileOf([localModel], null)],
        ["a second model added", fileOf([localModel, second], null)],
        ["a model edited", fileOf([{ ...localModel, modelId: "other:7b" }, second], null)],
        ["the default chosen", fileOf([{ ...localModel, modelId: "other:7b" }, second], "m-1")],
        ["the default changed", fileOf([{ ...localModel, modelId: "other:7b" }, second], "m-2")],
        ["a model disabled", fileOf([localModel, { ...second, enabled: false }], "m-2")],
        ["an empty registry", fileOf([], null)],
      ];
      for (const [what, file] of writes) {
        const res = await postModels(base, file);
        expect(res.status, what).toBe(200);
        expect(getCachedModelsFile(), what).toEqual(file);
        expect((await getSetting(base)).body, what).toEqual({ editing: true });
        expect(fs.readFileSync(settingsFile).equals(bytes), what).toBe(true);
        expect(localModelEditingState(), what).toEqual(state);
      }
    });

    it("a refused Models write leaves the setting alone too", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      const bytes = fs.readFileSync(settingsFile);

      const stale = await call(base, "POST", API_MODELS, {
        json: { file: fileOf([localModel], null), ifMatch: "not-the-etag" },
      });
      expect(stale.status).toBe(409);
      const invalid = await call(base, "POST", API_MODELS, {
        json: { file: { schemaVersion: 1, editing: false }, ifMatch: getModelsEtag() },
      });
      expect(invalid.status).toBe(400);

      expect((await getSetting(base)).body).toEqual({ editing: true });
      expect(fs.readFileSync(settingsFile).equals(bytes)).toBe(true);
    });

    it("a settings POST leaves models.json byte-identical and the registry etag unchanged", async () => {
      const base = await listen(makeApp({ live: true }));
      expect((await postModels(base, fileOf([localModel], "m-1"))).status).toBe(200);
      const bytes = fs.readFileSync(modelsFile);
      const etag = getModelsEtag();

      for (const editing of [true, false, true]) {
        expect((await postSetting(base, { editing })).status).toBe(200);
        expect(fs.readFileSync(modelsFile).equals(bytes)).toBe(true);
        expect(getModelsEtag()).toBe(etag);
      }
      expect(getCachedModelsFile()).toEqual(fileOf([localModel], "m-1"));
    });

    it("a settings POST with no models.json creates none", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      expect(fs.readdirSync(dir)).toEqual([LOCAL_MODEL_SETTINGS_FILE_NAME]);
    });

    it("GET /api/models does not carry the setting", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      await postModels(base, fileOf([localModel], "m-1"));
      const res = await call(base, "GET", API_MODELS);
      expect(JSON.stringify(res.body)).not.toContain("editing");
    });
  });

  describe("reconcile round-trip", () => {
    it("the real client reconcile action, run against this app, leaves the setting on and its file unchanged", async () => {
      const base = await listen(makeApp({ live: true }));
      await postSetting(base, { editing: true });
      const bytes = fs.readFileSync(settingsFile);

      // The browser's localStorage registry: one model the server has not seen.
      const storage = installLocalStorageStub();
      storage.set(
        TANDEM_SETTINGS_KEY,
        JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          models: [localModel],
          defaultModelId: "m-1",
        }),
      );

      // The client fetches its baked origin; forward to the in-process server
      // and add the Origin a browser would send (Node `fetch` sends none).
      const realFetch = globalThis.fetch;
      const forwarded: string[] = [];
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(API_BASE)) throw new Error(`unexpected fetch: ${url}`);
        forwarded.push(`${init?.method ?? "GET"} ${url.slice(API_BASE.length)}`);
        const headers = new Headers(init?.headers);
        headers.set("Origin", ALLOWED_ORIGIN);
        return realFetch(`${base}${url.slice(API_BASE.length)}`, { ...init, headers });
      });
      _resetModelsReconcileGuardForTests();

      expect(await reconcileModelsToServerOnce()).toBe("reconciled");

      // It really wrote the registry through the real route…
      expect(forwarded).toEqual([`GET ${API_MODELS}`, `POST ${API_MODELS}`]);
      expect(storage.get(MODELS_RECONCILED_FLAG_KEY)).toBe("1");
      expect(getCachedModelsFile()).toEqual({
        schemaVersion: 1,
        models: [localModel],
        defaultModelId: "m-1",
      });
      expect(JSON.parse(fs.readFileSync(modelsFile, "utf8"))).toEqual(getCachedModelsFile());

      // …and the setting did not move.
      vi.unstubAllGlobals();
      expect((await getSetting(base)).body).toEqual({ editing: true });
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(fs.readFileSync(settingsFile).equals(bytes)).toBe(true);

      // Nor after a restart that re-reads both files.
      __resetLocalModelSettingsForTests(dir);
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);
    });
  });

  describe("preflight", () => {
    it("every path this registrar gives a POST or DELETE also has an OPTIONS registration", () => {
      const src = readRegistrar("models/api-routes.ts");
      const constantsOf = (methods: string) =>
        new Set(
          [
            ...src.matchAll(new RegExp(String.raw`\bapp\.(?:${methods})\(\s*([A-Za-z_]\w*)`, "g")),
          ].map((m) => m[1]),
        );
      const mutating = constantsOf("post|put|patch|delete");
      const preflighted = constantsOf("options");

      // The scan is live: it sees the three paths this file registers.
      expect([...mutating].sort()).toEqual(
        ["API_MODELS", "API_MODELS_LOCAL_SETTINGS", "API_MODELS_SECRET"].sort(),
      );
      expect([...mutating].filter((c) => !preflighted.has(c))).toEqual([]);
      // And every registration names its path by constant, so none hides from it.
      expect(src.match(/\bapp\.(?:post|put|patch|delete|options)\(\s*["'`]/g)).toBeNull();
    });

    it("OPTIONS through the REAL apiMiddleware answers 204 and echoes an allowlisted Origin", async () => {
      const base = await listen(makeApp({ live: true, mw: apiMiddleware }));
      for (const origin of [ALLOWED_ORIGIN, "http://127.0.0.1:5173"]) {
        const res = await call(base, "OPTIONS", API_MODELS_LOCAL_SETTINGS, {
          origin,
          headers: {
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
        expect(res.headers.get("access-control-allow-methods")).toMatch(/\bPOST\b/);
        expect(res.headers.get("access-control-allow-headers")).toMatch(/content-type/i);
      }
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("the preflight is answered while dark as well", async () => {
      const base = await listen(makeApp({ mw: apiMiddleware }));
      const res = await call(base, "OPTIONS", API_MODELS_LOCAL_SETTINGS, {
        headers: { "Access-Control-Request-Method": "POST" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    });

    it("a foreign Origin's preflight gets no Access-Control-Allow-Origin at all", async () => {
      const base = await listen(makeApp({ live: true, mw: apiMiddleware }));
      for (const origin of ["https://evil.example", "null"]) {
        const res = await call(base, "OPTIONS", API_MODELS_LOCAL_SETTINGS, {
          origin,
          headers: { "Access-Control-Request-Method": "POST" },
        });
        expect(res.headers.has("access-control-allow-origin")).toBe(false);
      }
    });

    it("the JSON POST the preflight allows then works through the real middleware", async () => {
      const base = await listen(makeApp({ live: true, mw: apiMiddleware }));
      const post = await postSetting(base, { editing: true });
      expect(post.status).toBe(200);
      expect(post.body).toEqual({ editing: true, persisted: true });
      expect(post.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
      const get = await getSetting(base);
      expect(get.body).toEqual({ editing: true });
      expect(get.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    });
  });
});
