import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
} from "../../../src/server/integrations/keychain.js";
import {
  ANSWERING_CHANGED_NOTICE_KEY,
  answeringChangedNotice,
  answeringFingerprint,
  answeringSwitchedNotice,
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import { handleNotifyStream } from "../../../src/server/mcp/routes/notify-stream.js";
import { registerModelsRoutes } from "../../../src/server/models/api-routes.js";
import {
  __flushLocalModelAnnouncedForTests,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
  LOCAL_MODEL_BASELINE_FILE_NAME,
  SETTINGS_CHANGED_NOTICE,
  SETTINGS_CHANGED_NOTICE_KEY,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  EDITING_ON_NOTICE,
  EDITING_ON_NOTICE_KEY,
  isLocalModelEditingEnabled,
  LOCAL_MODEL_SETTINGS_FILE_NAME,
  primeLocalModelSettings,
} from "../../../src/server/models/local-model-settings.js";
import { createOwnWindowPolicy } from "../../../src/server/models/own-window.js";
import {
  __resetModelRegistryForTests,
  getModelsEtag,
  primeModelStoreCache,
} from "../../../src/server/models/registry.js";
import { createModelStore, MODELS_FILE_NAME } from "../../../src/server/models/store.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
  subscribe as subscribeNotifications,
} from "../../../src/server/notifications.js";
import { clearStartupNotices, getStartupNotices } from "../../../src/server/startup-notices.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  TAURI_HOSTNAME,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  type ModelsEntry,
  type ModelsFile,
} from "../../../src/shared/models/contract.js";
import { withInternal } from "../../../src/shared/origins.js";

/**
 * The notices fit the own-window rule (#2404, R3): through the REAL routes, the
 * real registry and settings modules, the real record on disk and the
 * collaborator's real wiring (`DEFAULT_COLLABORATOR_DEPS`' `answering`,
 * `announced` and `onModelsChanged`). Only the model run and the event queue
 * are doubles: no chat is sent in this file.
 *
 * `restart()` models a new process on the same app-data directory: nothing is
 * remembered but the files. `boot()` is what a lit `src/server/index.ts` does:
 * prime the registry, prime the settings, wire the collaborator.
 *
 * A record write is failed or held by replacing `atomicWriteConfigFile` for
 * that one file — never by file permissions — so the cases mean the same thing
 * on Windows and POSIX.
 */
const writeControl = vi.hoisted(() => ({
  /** Resolve / reject handles of announced-file writes being held in flight. */
  held: [] as Array<{ release: () => void; fail: () => void }>,
  hold: false,
  /** Content of every write of the announced file that was allowed through. */
  landed: [] as string[],
}));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
      if (!file.endsWith("local-model-announced.json")) {
        return actual.atomicWriteConfigFile(file, content);
      }
      if (writeControl.hold) {
        await new Promise<void>((resolve, reject) => {
          writeControl.held.push({
            release: resolve,
            fail: () => reject(new Error("simulated write failure")),
          });
        });
      }
      await actual.atomicWriteConfigFile(file, content);
      writeControl.landed.push(content);
    },
  };
});

const OWN_WINDOW_ORIGIN = `http://${TAURI_HOSTNAME}`;
const ALLOWANCE_ORIGIN = "http://127.0.0.1:5173";
const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

const A: ModelsEntry = {
  id: "entry-a",
  provider: "local-ollama",
  displayName: "Model A",
  modelId: "qwen2.5:14b-instruct",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};
const B: ModelsEntry = {
  id: "entry-b",
  provider: "local-llamacpp",
  displayName: "Model B",
  modelId: "/models/secret-path/mistral.gguf",
  endpoint: "http://127.0.0.1:11435",
  enabled: true,
};
const CLOUD: ModelsEntry = {
  id: "entry-cloud",
  provider: "anthropic",
  displayName: "Cloud",
  modelId: "claude-sonnet",
  apiKeyRef: "ref-cloud-credential",
  enabled: true,
};
const file = (models: ModelsEntry[], defaultModelId: string | null = null): ModelsFile => ({
  schemaVersion: 1,
  models,
  defaultModelId,
});
const fp = (m: ModelsEntry) =>
  answeringFingerprint({
    entryId: m.id,
    endpoint: m.endpoint as string,
    modelId: m.modelId,
    displayName: m.displayName,
  });
const answeringOf = (m: ModelsEntry) => ({
  entryId: m.id,
  endpoint: m.endpoint as string,
  modelId: m.modelId,
  displayName: m.displayName,
});

describe("local-model notices under the own-window rule (#2404 R3)", () => {
  let dir: string;
  let recordFile: string;
  let markerFile: string;
  let settingsFile: string;
  let server: Server;
  let baseUrl: string;
  let collab: ReturnType<typeof createLocalModelCollaborator> | null = null;
  let refusing = false;
  const streamClosers: Array<() => void> = [];
  const unsubscribers: Array<() => void> = [];

  // ── the routes ──────────────────────────────────────────────────────────────

  async function save(
    next: ModelsFile,
    origin = OWN_WINDOW_ORIGIN,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await fetch(`${baseUrl}${API_MODELS}`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ file: next, ifMatch: getModelsEtag(), ...extra }),
    });
    // A refused save would make every "nothing was raised" assertion vacuous.
    expect(res.status, await res.clone().text()).toBe(200);
  }

  async function setEditing(editing: boolean, origin = OWN_WINDOW_ORIGIN): Promise<void> {
    const res = await fetch(`${baseUrl}${API_MODELS_LOCAL_SETTINGS}`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ editing }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ editing, persisted: true });
  }

  // ── the process ─────────────────────────────────────────────────────────────

  /** What a lit `index.ts` does at start: prime, prime, wire. */
  async function boot(): Promise<void> {
    await primeModelStoreCache();
    primeLocalModelSettings();
    collab = createLocalModelCollaborator({
      ...DEFAULT_COLLABORATOR_DEPS,
      runTurn: async () => {
        throw new Error("no run is expected in this file");
      },
      subscribe: () => {},
      unsubscribe: () => {},
      aiRefusal: () =>
        refusing
          ? {
              error: "LICENSE_REQUIRED" as const,
              kind: "unlicensed" as const,
              message: "Tandem is unlicensed, so its AI features are turned off.",
            }
          : null,
    });
    collab.__startForTests();
  }

  function closeStreams(): void {
    for (const close of streamClosers.splice(0)) close();
    for (const stop of unsubscribers.splice(0)) stop();
  }

  /** A new process on the same directory. */
  async function shutdown(): Promise<void> {
    await collab?.stop();
    collab = null;
    closeStreams();
    await __flushLocalModelAnnouncedForTests();
    __resetLocalModelSettingsForTests(dir); // also forgets the announced module
    __resetModelRegistryForTests(dir);
    resetNotifications();
    clearStartupNotices();
  }

  async function restart(): Promise<void> {
    await shutdown();
    await boot();
  }

  // ── Tandem's own window ─────────────────────────────────────────────────────

  /** The desktop window connects to the notification stream (the real route). */
  function openOwnWindowStream(): string {
    const written: string[] = [];
    const req = {
      headers: { origin: OWN_WINDOW_ORIGIN },
      on: (event: string, cb: () => void) => {
        if (event === "close") streamClosers.push(cb);
      },
    } as unknown as Request;
    const res = {
      writableEnded: false,
      writeHead: () => res,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    } as unknown as Response;
    handleNotifyStream(req, res);
    return written.join("");
  }

  /** One of Tandem's own windows is already listening when something is raised. */
  function ownWindowListening(): void {
    unsubscribers.push(subscribeNotifications(() => {}, { ownWindow: true }));
  }

  // ── what was said, and what is on disk ──────────────────────────────────────

  const warnings = () => getBuffer().filter((n) => n.severity === "warning");
  const infos = () => getBuffer().filter((n) => n.severity === "info");
  const pending = (key: string) => getStartupNotices().filter((n) => n.dedupKey === key);
  const expectSilent = (why = "nothing was raised") => {
    expect(getBuffer(), why).toEqual([]);
    expect(getStartupNotices(), why).toEqual([]);
  };

  async function record(): Promise<{ editing: boolean; answering: string | null } | null> {
    await __flushLocalModelAnnouncedForTests();
    if (!fs.existsSync(recordFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
      version: number;
      editing: boolean;
      answering: string | null;
    };
    expect(parsed.version).toBe(1);
    return { editing: parsed.editing, answering: parsed.answering };
  }

  /** Change `models.json` underneath Tandem: another writer, not the route. */
  async function writeModelsUnderneath(next: ModelsFile): Promise<void> {
    await createModelStore(dir).write(next);
  }

  function writeSettingsUnderneath(editing: boolean): void {
    fs.writeFileSync(settingsFile, `${JSON.stringify({ version: 1, editing }, null, 2)}\n`);
  }

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-own-window-notices-"));
    recordFile = path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    markerFile = path.join(dir, LOCAL_MODEL_BASELINE_FILE_NAME);
    settingsFile = path.join(dir, LOCAL_MODEL_SETTINGS_FILE_NAME);
    __resetLocalModelSettingsForTests(dir);
    __resetModelRegistryForTests(dir);
    resetNotifications();
    clearStartupNotices();
    writeControl.hold = false;
    writeControl.held = [];
    writeControl.landed = [];
    refusing = false;
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const app = express();
    app.use(express.json());
    registerModelsRoutes(app, passthrough, passthrough, {
      keychain: createKeychain({
        service: KEYCHAIN_SERVICE_MODELS,
        backend: { get: () => null, set: () => {}, delete: () => false },
      }),
      ownWindow: createOwnWindowPolicy({ getBound: () => null, allowance: ALLOWANCE_ORIGIN }),
      localModelSettingsEnabled: true,
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    writeControl.hold = false;
    for (const w of writeControl.held.splice(0)) w.release();
    await collab?.stop();
    collab = null;
    closeStreams();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await __flushLocalModelAnnouncedForTests();
    __resetLocalModelSettingsForTests();
    __resetModelRegistryForTests();
    resetNotifications();
    clearStartupNotices();
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── R3.1: the user's own change ─────────────────────────────────────────────

  describe("a change from Tandem's own window is the user's: no warning, and the record matches at once (R3.1)", () => {
    it("first-time setup — add a model, mark it default, switch commenting on — shows no warnings", async () => {
      await boot();
      await save(file([A]));
      expect(await record()).toEqual({ editing: false, answering: fp(A) });
      await save(file([A], A.id));
      await setEditing(true);

      expectSilent("first-time setup raises nothing at all");
      expect(await record()).toEqual({ editing: true, answering: fp(A) });
    });

    it("a restart after the user's own changes is silent", async () => {
      await boot();
      await save(file([A], A.id));
      await setEditing(true);
      await restart();
      expectSilent("a restart after an own-window change");
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(await record()).toEqual({ editing: true, answering: fp(A) });
      // …and the one after that.
      await restart();
      expectSilent();
    });

    it("editing the answering model's Endpoint or model id records the new identity, silently", async () => {
      await boot();
      await save(file([A], A.id));
      const moved = { ...A, endpoint: "http://127.0.0.1:12000" };
      await save(file([moved], A.id));
      expectSilent();
      expect(await record()).toEqual({ editing: false, answering: fp(moved) });
      const renamedModel = { ...moved, modelId: "llama3.2" };
      await save(file([renamedModel], A.id));
      expectSilent();
      expect((await record())?.answering).toBe(fp(renamedModel));
      await restart();
      expectSilent();
    });

    it("Off and On again from the own window raise nothing, and the record follows", async () => {
      await boot();
      await setEditing(true);
      await setEditing(false);
      expect((await record())?.editing).toBe(false);
      await setEditing(true);
      expectSilent();
      expect((await record())?.editing).toBe(true);
      await restart();
      expectSilent();
    });

    it("the model stops answering and answers again, all from the own window: silent, and silent after a restart", async () => {
      await boot();
      await save(file([A], A.id));
      await save(file([{ ...A, enabled: false }], A.id));
      expect((await record())?.answering).toBeNull();
      await save(file([A], A.id));
      expectSilent();
      expect((await record())?.answering).toBe(fp(A));
      await restart();
      expectSilent();
    });
  });

  // ── R1.5 / R3.1: the allowance is not the user's own window ────────────────

  describe("a write admitted through the development allowance still raises the notices, as #2403 built them", () => {
    it("saving a model: the answering-changed warning, registered for replay, and nothing recorded until a window is sent it", async () => {
      await boot();
      await save(file([A]), ALLOWANCE_ORIGIN);

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatchObject({
        dedupKey: ANSWERING_CHANGED_NOTICE_KEY,
        message: answeringChangedNotice(answeringOf(A)),
        severity: "warning",
      });
      expect(infos()).toEqual([]);
      expect(pending(ANSWERING_CHANGED_NOTICE_KEY)).toHaveLength(1);
      expect((await record())?.answering ?? null).toBeNull();

      // Tandem's own window connects and is sent the replay: now it is told.
      // (The stream carries JSON, so the notice's quotes arrive escaped.)
      expect(openOwnWindowStream()).toContain(
        JSON.stringify(answeringChangedNotice(answeringOf(A))),
      );
      expect((await record())?.answering).toBe(fp(A));
    });

    it("switching commenting on: the editing-on warning, registered for replay, not recorded", async () => {
      await boot();
      await setEditing(true, ALLOWANCE_ORIGIN);

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatchObject({
        dedupKey: EDITING_ON_NOTICE_KEY,
        message: EDITING_ON_NOTICE,
      });
      expect(pending(EDITING_ON_NOTICE_KEY)).toHaveLength(1);
      expect((await record())?.editing ?? false).toBe(false);

      // Nobody was sent it, so the next start says so.
      await restart();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it("with one of Tandem's own windows listening, the warning is raised and recorded as told", async () => {
      await boot();
      ownWindowListening();
      await save(file([A]), ALLOWANCE_ORIGIN);
      await setEditing(true, ALLOWANCE_ORIGIN);
      expect(warnings().map((n) => n.dedupKey)).toEqual([
        ANSWERING_CHANGED_NOTICE_KEY,
        EDITING_ON_NOTICE_KEY,
      ]);
      expect(await record()).toEqual({ editing: true, answering: fp(A) });
      await restart();
      expectSilent("told: the next start is silent");
    });

    it("a reconcile flag does not quieten an allowance write", async () => {
      await boot();
      await save(file([A]), ALLOWANCE_ORIGIN, { reconcile: true });
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0].dedupKey).toBe(ANSWERING_CHANGED_NOTICE_KEY);
    });

    it("an own-window write that does not touch the answering model leaves the record and the pending warning alone", async () => {
      await boot();
      await save(file([A]), ALLOWANCE_ORIGIN);
      expect(pending(ANSWERING_CHANGED_NOTICE_KEY)).toHaveLength(1);
      const before = getBuffer().length;

      // The user adds a cloud entry in Tandem's own window. A still answers,
      // and this write did not add, edit or default it.
      await save(file([A, CLOUD]));

      expect(getBuffer()).toHaveLength(before);
      expect(infos()).toEqual([]);
      expect(pending(ANSWERING_CHANGED_NOTICE_KEY), "still waiting for a window").toHaveLength(1);
      expect((await record())?.answering ?? null, "the user's edit blessed nothing").toBeNull();

      // A restart still says so.
      await restart();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });
  });

  // ── R3.1a: the side-effect switch ───────────────────────────────────────────

  describe("the one thing the user's own change can do unnoticed: make a different model answer (R3.1a)", () => {
    function expectOneInfoNaming(m: ModelsEntry): void {
      expect(warnings()).toEqual([]);
      expect(infos()).toHaveLength(1);
      const [notice] = infos();
      expect(notice.message).toBe(answeringSwitchedNotice(answeringOf(m)));
      expect(notice.message).toContain(`"${m.displayName}"`);
      expect(notice.dedupKey).toBeUndefined();
      // Activity tray only: never held for replay, never a start-up notice.
      expect(getStartupNotices()).toEqual([]);
    }

    it("A is the default and B is enabled: deleting A makes B answer → one info notice", async () => {
      await boot();
      await save(file([A, B], A.id));
      expectSilent();
      await save(file([B]));
      expectOneInfoNaming(B);
      expect((await record())?.answering).toBe(fp(B));
      await restart();
      expectSilent("the switch was recorded, so the next start is silent");
    });

    it("A and B enabled with no default (nothing answers): disabling A makes B answer → one info notice", async () => {
      await boot();
      await save(file([A, B]));
      expect((await record())?.answering ?? null).toBeNull();
      await save(file([{ ...A, enabled: false }, B]));
      expectOneInfoNaming(B);
      expect((await record())?.answering).toBe(fp(B));
    });

    it("A and B enabled with no default: deleting A makes B answer → one info notice", async () => {
      await boot();
      await save(file([A, B]));
      await save(file([B]));
      expectOneInfoNaming(B);
    });

    it("a cloud default with a local model B enabled: deleting the cloud default makes B answer → one info notice", async () => {
      await boot();
      await save(file([CLOUD, B], CLOUD.id));
      expectSilent();
      await save(file([B]));
      expectOneInfoNaming(B);
      expect((await record())?.answering).toBe(fp(B));
    });

    it("the notice never carries the Endpoint or the model id", async () => {
      await boot();
      await save(file([A, B], A.id));
      await save(file([B]));
      const text = JSON.stringify(infos());
      expect(text).not.toContain(B.endpoint as string);
      expect(text).not.toContain(B.modelId);
      expect(text).not.toContain("11435");
    });

    describe("no info notice when the user added, edited or defaulted the model that then answers", () => {
      it("adding the model that then answers", async () => {
        await boot();
        await save(file([A]));
        expectSilent();
      });

      it("adding B and deleting A in one write", async () => {
        await boot();
        await save(file([A], A.id));
        await save(file([B]));
        expectSilent();
        expect((await record())?.answering).toBe(fp(B));
      });

      it("editing the Endpoint of the model that answers", async () => {
        await boot();
        await save(file([A], A.id));
        await save(file([{ ...A, endpoint: "http://127.0.0.1:12000" }], A.id));
        expectSilent();
      });

      it("editing B (renaming it) in the same write that removes the default A", async () => {
        await boot();
        await save(file([A, B], A.id));
        await save(file([{ ...B, displayName: "Renamed" }]));
        expectSilent();
      });

      it("enabling B in the same write: B was edited", async () => {
        await boot();
        await save(file([A, { ...B, enabled: false }], A.id));
        await save(file([B]));
        expectSilent();
      });

      it("making B the default", async () => {
        await boot();
        await save(file([A, B]));
        await save(file([A, B], B.id));
        expectSilent();
        expect((await record())?.answering).toBe(fp(B));
      });

      it("switching the default from A to B", async () => {
        await boot();
        await save(file([A, B], A.id));
        await save(file([A, B], B.id));
        expectSilent();
        expect((await record())?.answering).toBe(fp(B));
      });
    });

    it("a reconcile write never raises it, even when it switches the answering model", async () => {
      await boot();
      await save(file([A, B], A.id));
      await save(file([B]), OWN_WINDOW_ORIGIN, { reconcile: true });
      expectSilent("the one-time reconcile is not announced");
      expect((await record())?.answering).toBe(fp(B));
      await restart();
      expectSilent();
    });

    it("only the literal `reconcile: true` counts", async () => {
      await boot();
      await save(file([A, B], A.id));
      await save(file([B]), OWN_WINDOW_ORIGIN, { reconcile: "true" });
      expect(infos()).toHaveLength(1);
    });

    it("disabling the default A does NOT make a spare B answer: no notice, and the record is cleared", async () => {
      await boot();
      await save(file([A, B], A.id));
      expect((await record())?.answering).toBe(fp(A));
      await save(file([{ ...A, enabled: false }, B], A.id));
      expectSilent();
      expect((await record())?.answering).toBeNull();
    });

    it("a write that leaves the answering model as it was raises nothing", async () => {
      await boot();
      await save(file([A, B], A.id));
      await save(file([A, { ...B, displayName: "Other" }], A.id));
      await save(file([A], A.id));
      expectSilent();
      expect((await record())?.answering).toBe(fp(A));
    });
  });

  // ── R3.2: the start-up check ────────────────────────────────────────────────

  describe("a file changed underneath is announced once at the next start (R3.2)", () => {
    function expectTheStartupNotice(): void {
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
      expect(getStartupNotices(), "one notice, whatever differs").toHaveLength(1);
      const [notice] = getStartupNotices();
      expect(notice).toMatchObject({
        severity: "warning",
        message: SETTINGS_CHANGED_NOTICE,
        dedupKey: SETTINGS_CHANGED_NOTICE_KEY,
      });
      expect(warnings().every((n) => n.dedupKey === SETTINGS_CHANGED_NOTICE_KEY)).toBe(true);
      expect(infos()).toEqual([]);
    }

    it("the copy is the decided wording", () => {
      expect(SETTINGS_CHANGED_NOTICE).toBe(
        "Your local-model settings changed since Tandem last recorded them. If you did not change them, check Settings → Models: remove any model you do not recognise and switch commenting off. This can also appear after an upgrade or after restoring Tandem's data.",
      );
    });

    it("models.json changed underneath: one notice; once an own window received it, the following start is silent", async () => {
      await boot();
      await save(file([A], A.id));
      await restart();
      expectSilent();

      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      await boot();
      expectTheStartupNotice();
      expect((await record())?.answering, "not recorded until a window is sent it").toBe(fp(A));

      // A restart with no window ever connecting says it again.
      await restart();
      expectTheStartupNotice();

      expect(openOwnWindowStream()).toContain(SETTINGS_CHANGED_NOTICE);
      expect((await record())?.answering).toBe(fp(B));
      await restart();
      expectSilent("an own window was sent it");
    });

    it("local-model-settings.json changed underneath: one notice; delivered; then silent", async () => {
      await boot();
      await restart();
      expectSilent();

      await shutdown();
      writeSettingsUnderneath(true);
      await boot();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expectTheStartupNotice();
      expect((await record())?.editing ?? false).toBe(false);

      openOwnWindowStream();
      expect((await record())?.editing).toBe(true);
      await restart();
      expectSilent();
    });

    it("both changed underneath: still ONE notice, and delivery records both", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      writeSettingsUnderneath(true);
      await boot();

      expectTheStartupNotice();
      openOwnWindowStream();
      expect(await record()).toEqual({ editing: true, answering: fp(B) });
      await restart();
      expectSilent();
    });

    it("a stream that is not Tandem's own window receives it but does not count", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      await boot();

      const written: string[] = [];
      handleNotifyStream(
        {
          headers: { host: "127.0.0.1:3479", origin: "http://127.0.0.1:8080" },
          on: (event: string, cb: () => void) => {
            if (event === "close") streamClosers.push(cb);
          },
        } as unknown as Request,
        {
          writableEnded: false,
          writeHead: () => undefined,
          write: (chunk: string) => {
            written.push(chunk);
            return true;
          },
        } as unknown as Response,
      );
      expect(written.join("")).toContain(SETTINGS_CHANGED_NOTICE);
      expect((await record())?.answering).toBe(fp(A));
      await restart();
      expectTheStartupNotice();
    });

    it("Off (from the own window) withdraws the commenting part; with nothing else pending the notice goes", async () => {
      await boot();
      await shutdown();
      writeSettingsUnderneath(true);
      await boot();
      expectTheStartupNotice();
      await setEditing(false);
      expect(getStartupNotices()).toEqual([]);
      await restart();
      expectSilent();
    });

    it("the user's own change before their window's stream connects is what delivery records (round-1 H1)", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      await boot();
      expectTheStartupNotice();

      // The user's own window changes the model before its stream is open.
      const C: ModelsEntry = { ...A, id: "entry-c", displayName: "Model C" };
      await save(file([C], C.id));
      expect((await record())?.answering).toBe(fp(C));
      expect(warnings().every((n) => n.dedupKey === SETTINGS_CHANGED_NOTICE_KEY)).toBe(true);

      // Then the stream connects and is sent the start-up notice.
      const sent = openOwnWindowStream();
      expect(sent).toContain(SETTINGS_CHANGED_NOTICE);
      for (const m of [A, B, C]) expect(sent).not.toContain(m.displayName);
      expect((await record())?.answering, "never the value captured at boot").toBe(fp(C));

      await restart();
      expectSilent("the user's own change is not announced at the next start");
    });

    it("an untouched own-window write does not withdraw or satisfy the start-up notice", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      await boot();
      expectTheStartupNotice();

      await save(file([B, CLOUD], B.id));
      expectTheStartupNotice();
      expect((await record())?.answering).toBe(fp(A));
      await restart();
      expectTheStartupNotice();
    });

    it("is raised in Solo mode and while the licence refuses AI", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B], B.id));
      writeSettingsUnderneath(true);

      const ctrl = getOrCreateDocument(CTRL_ROOM);
      withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "solo"));
      refusing = true;
      await boot();
      expectTheStartupNotice();
    });

    it("carries no endpoint, model id, path, display name or credential", async () => {
      await boot();
      await save(file([A, CLOUD], A.id));
      await shutdown();
      await writeModelsUnderneath(file([B, CLOUD], B.id));
      writeSettingsUnderneath(true);
      await boot();

      const text = `${JSON.stringify(getStartupNotices())}${JSON.stringify(getBuffer())}`;
      for (const m of [A, B, CLOUD]) {
        if (m.endpoint) expect(text).not.toContain(m.endpoint);
        expect(text).not.toContain(m.modelId);
        expect(text).not.toContain(m.displayName);
        expect(text).not.toContain(m.id);
        if (m.apiKeyRef) expect(text).not.toContain(m.apiKeyRef);
      }
      expect(text).not.toContain(dir);
      expect(text).not.toMatch(/127\.0\.0\.1|localhost|https?:\/\//);
      expect(text).not.toContain(".json");
      expect(text).not.toContain(fp(B));
    });
  });

  // ── R3.2a: the first start with the flag on ─────────────────────────────────

  describe("the first start with the flag on takes what it finds as the baseline (R3.2a)", () => {
    it("a models.json written while dark, then the first lit start: nothing is raised", async () => {
      // Dark: the route answers (the reconcile posts through it) but nothing
      // is wired, so nothing records the write.
      await save(file([A]), OWN_WINDOW_ORIGIN, { reconcile: true });
      expect(fs.readdirSync(dir)).toEqual([MODELS_FILE_NAME]);

      await shutdown();
      await boot();
      expectSilent("the upgrading cohort is not warned at the flip");
      expect(await record()).toEqual({ editing: false, answering: fp(A) });
      expect(fs.existsSync(markerFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(markerFile, "utf8"))).toEqual({ version: 1 });

      await restart();
      expectSilent();
    });

    it("a first lit start with nothing saved still writes the marker and an empty record", async () => {
      await boot();
      expectSilent();
      expect(await record()).toEqual({ editing: false, answering: null });
      expect(fs.existsSync(markerFile)).toBe(true);
    });

    it("the baseline is taken once: a model that appears underneath afterwards is announced", async () => {
      await boot();
      await shutdown();
      await writeModelsUnderneath(file([A]));
      await boot();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it("a missing record at a later start still announces", async () => {
      await save(file([A]));
      await shutdown();
      await boot(); // first lit start: baseline + marker
      await shutdown();
      fs.rmSync(recordFile);
      expect(fs.existsSync(markerFile)).toBe(true);

      await boot();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY), "a lost record is not a baseline").toHaveLength(
        1,
      );
    });

    it("a corrupt record at a later start still announces", async () => {
      await save(file([A]));
      await shutdown();
      await boot();
      await shutdown();
      fs.writeFileSync(recordFile, "{ not json");

      await boot();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it.each([
      [
        "a record of a later version",
        JSON.stringify({ version: 2, editing: true, answering: "x" }),
      ],
      ["an oversized record", JSON.stringify({ version: 1, pad: "x".repeat(8192) })],
      ["a record that is an array", "[]"],
    ])("%s reads as nothing recorded, and announces", async (_label, content) => {
      await save(file([A]));
      await shutdown();
      await boot();
      await shutdown();
      fs.writeFileSync(recordFile, content);
      await boot();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it("a lost marker with a record present still announces a mismatch (and the marker is written again)", async () => {
      await save(file([A]));
      await shutdown();
      await boot();
      expect((await record())?.answering).toBe(fp(A));
      await shutdown();
      fs.rmSync(markerFile);
      await writeModelsUnderneath(file([B]));

      await boot();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY), "the record exists: no baseline").toHaveLength(
        1,
      );
      expect((await record())?.answering).toBe(fp(A));
      expect(fs.existsSync(markerFile)).toBe(true);
    });

    it("a lost marker with a matching record is silent", async () => {
      await save(file([A]));
      await shutdown();
      await boot();
      await shutdown();
      fs.rmSync(markerFile);
      await boot();
      expectSilent();
      await __flushLocalModelAnnouncedForTests();
      expect(fs.existsSync(markerFile)).toBe(true);
    });

    describe("anything found at the marker's path counts as present", () => {
      async function startWithMarker(make: () => void): Promise<void> {
        await writeModelsUnderneath(file([A]));
        make();
        expect(fs.existsSync(recordFile)).toBe(false);
        await shutdown();
        await boot();
        expect(
          pending(SETTINGS_CHANGED_NOTICE_KEY),
          "a marker with no record is not the upgrading cohort's state",
        ).toHaveLength(1);
      }

      it("corrupt content", async () => {
        await startWithMarker(() => fs.writeFileSync(markerFile, "\u0000 not json"));
        expect(fs.readFileSync(markerFile, "utf8")).toBe("\u0000 not json");
      });

      it("an empty file", async () => {
        await startWithMarker(() => fs.writeFileSync(markerFile, ""));
      });

      it("a directory", async () => {
        await startWithMarker(() => fs.mkdirSync(markerFile));
        expect(fs.statSync(markerFile).isDirectory()).toBe(true);
      });

      it.skipIf(process.platform === "win32")("a dangling link", async () => {
        await startWithMarker(() => fs.symlinkSync(path.join(dir, "nowhere"), markerFile));
        expect(fs.lstatSync(markerFile).isSymbolicLink()).toBe(true);
      });
    });

    it.skipIf(process.platform === "win32")(
      "a record path that is a dangling link counts as a record: no baseline",
      async () => {
        await writeModelsUnderneath(file([A]));
        fs.symlinkSync(path.join(dir, "nowhere"), recordFile);
        await shutdown();
        await boot();
        expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
      },
    );

    it("commenting found switched on at a first lit start IS announced (no dark build can write that file)", async () => {
      await writeModelsUnderneath(file([A]));
      writeSettingsUnderneath(true);
      await shutdown();
      await boot();

      expect(getStartupNotices()).toHaveLength(1);
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
      // The answering model is still taken as the baseline.
      expect(await record()).toEqual({ editing: false, answering: fp(A) });

      openOwnWindowStream();
      expect(await record()).toEqual({ editing: true, answering: fp(A) });
      await restart();
      expectSilent();
    });

    it("a dark build creates no marker and no record: dark route calls, no prime, no wiring", async () => {
      const app = express();
      app.use(express.json());
      registerModelsRoutes(app, passthrough, passthrough, {
        keychain: createKeychain({
          service: KEYCHAIN_SERVICE_MODELS,
          backend: { get: () => null, set: () => {}, delete: () => false },
        }),
        ownWindow: createOwnWindowPolicy({ getBound: () => null, allowance: ALLOWANCE_ORIGIN }),
        // `localModelSettingsEnabled` omitted: the dark flag.
      });
      const dark = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      try {
        const addr = dark.address();
        if (typeof addr !== "object" || addr === null) throw new Error("no address");
        const url = `http://127.0.0.1:${addr.port}`;
        for (const origin of [OWN_WINDOW_ORIGIN, ALLOWANCE_ORIGIN]) {
          const models = await fetch(`${url}${API_MODELS}`, {
            method: "POST",
            headers: { Origin: origin, "content-type": "application/json" },
            body: JSON.stringify({ file: file([A, B], A.id), ifMatch: getModelsEtag() }),
          });
          expect(models.status).toBe(200);
          const settings = await fetch(`${url}${API_MODELS_LOCAL_SETTINGS}`, {
            method: "POST",
            headers: { Origin: origin, "content-type": "application/json" },
            body: JSON.stringify({ editing: true }),
          });
          expect(settings.status).toBe(404);
        }
        await __flushLocalModelAnnouncedForTests();
        expect(fs.readdirSync(dir)).toEqual([MODELS_FILE_NAME]);
        expectSilent("a dark write is never announced");
      } finally {
        await new Promise<void>((resolve) => {
          dark.close(() => resolve());
          dark.closeAllConnections();
        });
      }
    });
  });

  // ── R3.3: the record's own failures ─────────────────────────────────────────

  describe("a failed record write is retried, including one still in flight (R3.3)", () => {
    it("a clearing write that fails after the next change arrived does not leave a stale 'told' on disk", async () => {
      await boot();
      ownWindowListening();
      await setEditing(true, ALLOWANCE_ORIGIN); // told: recorded
      expect((await record())?.editing).toBe(true);
      closeStreams();

      // Off: the clearing write is started and held — it has not failed YET.
      writeControl.hold = true;
      await setEditing(false, ALLOWANCE_ORIGIN);
      await vi.waitFor(() => expect(writeControl.held).toHaveLength(1));

      // On again with no window open, while that write is still in flight.
      // Nothing new is recorded; the stale file must not survive.
      writeControl.hold = false;
      await setEditing(true, ALLOWANCE_ORIGIN);
      expect(pending(EDITING_ON_NOTICE_KEY)).toHaveLength(1);

      // Now the held write fails.
      const landedBefore = writeControl.landed.length;
      writeControl.held[0].fail();
      writeControl.held = [];
      await __flushLocalModelAnnouncedForTests();

      expect(writeControl.landed.length, "a retry was queued and landed").toBeGreaterThan(
        landedBefore,
      );
      expect((await record())?.editing, "the file no longer says 'told'").toBe(false);

      // So the next start announces the switch nobody saw.
      await restart();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it("a record write that failed after the user's own change costs one start-up notice, never silence about a later change", async () => {
      await boot();
      await save(file([A], A.id));
      expect((await record())?.answering).toBe(fp(A));

      // The record of the user's own change to B never reaches the disk.
      writeControl.hold = true;
      await save(file([B], B.id));
      await vi.waitFor(() => expect(writeControl.held).toHaveLength(1));
      writeControl.hold = false;
      writeControl.held[0].fail();
      writeControl.held = [];
      await __flushLocalModelAnnouncedForTests();
      expect(JSON.parse(fs.readFileSync(recordFile, "utf8")).answering).toBe(fp(A));

      await restart();
      expect(pending(SETTINGS_CHANGED_NOTICE_KEY)).toHaveLength(1);
    });

    it("the next own-window write retries a failed record write even when it changes nothing recorded", async () => {
      await boot();
      await save(file([A], A.id));
      writeControl.hold = true;
      await save(file([B], B.id));
      await vi.waitFor(() => expect(writeControl.held).toHaveLength(1));
      writeControl.hold = false;
      writeControl.held[0].fail();
      writeControl.held = [];
      await __flushLocalModelAnnouncedForTests();

      // An unrelated edit in Tandem's own window: B still answers, untouched.
      await save(file([B, CLOUD], B.id));
      expect((await record())?.answering).toBe(fp(B));
      await restart();
      expectSilent();
    });

    it("wire() clears a stale record when nothing answers at start-up", async () => {
      await boot();
      await save(file([A], A.id));
      await shutdown();
      await writeModelsUnderneath(file([]));
      await boot();
      expectSilent();
      expect((await record())?.answering).toBeNull();
    });
  });
});

// ── R3.2 / R3.4: by source ────────────────────────────────────────────────────

describe("the record modules consult neither the mode nor the licence (#2404 R3.2)", () => {
  const read = (rel: string) =>
    fs
      .readFileSync(path.join(__dirname, "../../../src/server", rel), "utf8")
      // comments out: the headers discuss both
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it.each([
    "models/local-model-announced.ts",
    "models/local-model-settings.ts",
    "models/own-window.ts",
  ])("%s imports no mode, licence or local-model engine module", (rel) => {
    const imports = [...read(rel).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec, `${rel} imports ${spec}`).not.toMatch(/mode\.js$|\/license\/|local-model\//);
    }
  });

  it("the collaborator's wire() raises the start-up check before it subscribes, with no mode or licence read in it", () => {
    const src = read("local-model/collaborator.ts");
    const start = src.indexOf("function wire(): void {");
    const end = src.indexOf("function start(): void {");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wire = src.slice(start, end);
    expect(wire).toContain("startupMismatch");
    expect(wire).toContain("finishStart");
    expect(wire).not.toMatch(/readLiveMode|decideRefusal|aiRefusal/);
    expect(wire.indexOf("startupMismatch")).toBeLessThan(wire.indexOf("deps.subscribe("));
  });

  it("the route handlers never touch the record: POST /api/models runs while dark", () => {
    const routes = read("models/api-routes.ts");
    expect(routes).not.toMatch(/local-model-announced/);
  });
});
