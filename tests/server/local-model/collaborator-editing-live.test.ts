import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenDocs } from "../../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry-testing.js";
import { resetForTesting as resetQueue } from "../../../src/server/events/queue.js";
import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
  type KeychainBackend,
} from "../../../src/server/integrations/keychain.js";
import {
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import {
  diagnoseLocalModel,
  resolveLocalModelConfig,
} from "../../../src/server/local-model/config-source.js";
import type { LoopResult, RunTurnOpts } from "../../../src/server/local-model/index.js";
import { runLocalModelTurn } from "../../../src/server/local-model/index.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { registerModelsRoutes } from "../../../src/server/models/api-routes.js";
import {
  __resetLocalModelSettingsForTests,
  localModelEditingState,
} from "../../../src/server/models/local-model-settings.js";
import {
  __resetModelRegistryForTests,
  getModelsEtag,
  onModelsFileChanged,
} from "../../../src/server/models/registry.js";
import { resetForTesting as resetNotifications } from "../../../src/server/notifications.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  TAURI_HOSTNAME,
  Y_MAP_CHAT,
  Y_MAP_CHAT_STREAM,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import {
  API_MODELS,
  API_MODELS_LOCAL_SETTINGS,
  type ModelsFile,
} from "../../../src/shared/models/contract.js";
import { withInternal } from "../../../src/shared/origins.js";

/**
 * #1123 R2.4, end to end across the joints the unit tests cover one at a time:
 * the REAL `POST /api/models/local-settings` route → the REAL settings module →
 * the collaborator's per-run `editingAllowed` closure. Only the model call
 * (`runTurn`) and the event-queue subscription are doubles.
 *
 * The collaborator here is built from `DEFAULT_COLLABORATOR_DEPS` with just
 * those two swapped, so this file is also what fails if production stops
 * wiring a seam — each of them fails CLOSED when absent, so a dropped line
 * turns a feature off without failing any test that injects its own.
 */

const DOC = "doc-editing-live";
const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

function memoryBackend(): KeychainBackend {
  const entries = new Map<string, string>();
  const key = (service: string, account: string) => `${service}::${account}`;
  return {
    get: (service, account) => entries.get(key(service, account)) ?? null,
    set: (service, account, secret) => {
      entries.set(key(service, account), secret);
    },
    delete: (service, account) => entries.delete(key(service, account)),
  };
}

function cleanResult(): LoopResult {
  return {
    metrics: {
      turns: 1,
      toolCalls: 0,
      jsonParseFailures: 0,
      anchorResolutionFailures: 0,
      flatOnlyAnchors: 0,
      replyFailures: 0,
      wallMs: 1,
      exit: "clean",
    },
    steps: [],
    finalContent: "",
    messages: [],
  };
}

const REGISTRY: ModelsFile = {
  schemaVersion: 1,
  models: [
    {
      id: "m-1",
      provider: "local-ollama",
      displayName: "Local One",
      modelId: "qwen2.5:14b-instruct",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    },
  ],
  defaultModelId: "m-1",
};

describe("production wiring of the collaborator's seams (#1123)", () => {
  it("DEFAULT_COLLABORATOR_DEPS wires every seam that fails closed when absent", () => {
    expect(DEFAULT_COLLABORATOR_DEPS.runTurn).toBe(runLocalModelTurn);
    expect(DEFAULT_COLLABORATOR_DEPS.resolveConfig).toBe(resolveLocalModelConfig);
    expect(DEFAULT_COLLABORATOR_DEPS.diagnose).toBe(diagnoseLocalModel);
    expect(DEFAULT_COLLABORATOR_DEPS.editingState).toBe(localModelEditingState);
    expect(DEFAULT_COLLABORATOR_DEPS.onModelsChanged).toBe(onModelsFileChanged);
  });
});

describe("switching editing through the real route reaches a run in flight (#1123 R2.4)", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let collab: ReturnType<typeof createLocalModelCollaborator>;
  let deliver: (e: TandemEvent) => void;
  /** What each run does while "the model is thinking". */
  let duringRun: (opts: RunTurnOpts) => Promise<void>;
  let seq = 0;

  const headers = { Origin: `http://${TAURI_HOSTNAME}`, "content-type": "application/json" };

  async function setEditing(editing: boolean): Promise<void> {
    const res = await fetch(`${baseUrl}${API_MODELS_LOCAL_SETTINGS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ editing }),
    });
    // A refused switch would make every assertion below vacuous.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ editing, persisted: true });
  }

  async function chat(): Promise<void> {
    const messageId = `editing-live-${seq++}`;
    deliver({
      id: `evt_${messageId}`,
      type: "chat:message",
      timestamp: Date.now(),
      documentId: DOC,
      payload: { messageId, text: "hello", replyTo: null, anchor: null },
    });
    await Promise.resolve();
    await collab.__awaitCurrent();
  }

  beforeEach(async () => {
    resetQueue();
    resetNotifications();
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => {
      ctrl.getMap(Y_MAP_CHAT).clear();
      ctrl.getMap(Y_MAP_CHAT_STREAM).clear();
      ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE); // unset reads as Tandem
    });

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-editing-live-"));
    __resetModelRegistryForTests(tmpDir);
    __resetLocalModelSettingsForTests(tmpDir);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ydoc = getOrCreateDocument(DOC);
    populateYDoc(ydoc, "# Title\n\nBody.");
    addDoc(DOC, {
      id: DOC,
      filePath: path.join(tmpDir, `${DOC}.md`),
      format: "md",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(DOC);

    duringRun = async () => {};
    let registered: ((e: TandemEvent) => void) | null = null;
    collab = createLocalModelCollaborator({
      // Production's seams, with only the model call and the queue swapped.
      ...DEFAULT_COLLABORATOR_DEPS,
      runTurn: async (opts) => {
        await duringRun(opts);
        return cleanResult();
      },
      subscribe: (cb) => {
        registered = cb;
      },
      unsubscribe: () => {},
      aiRefusal: () => null,
    });
    collab.__startForTests();
    if (!registered) throw new Error("the collaborator did not subscribe");
    deliver = registered;

    const app = express();
    app.use(express.json());
    registerModelsRoutes(app, passthrough, passthrough, {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend: memoryBackend() }),
      localModelSettingsEnabled: true,
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const saved = await fetch(`${baseUrl}${API_MODELS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file: REGISTRY, ifMatch: getModelsEtag() }),
    });
    expect(saved.status).toBe(200);
  });

  afterEach(async () => {
    await collab.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
    removeDoc(DOC);
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("the default is chat tier: a run started with nothing switched may not write", async () => {
    const seen: boolean[] = [];
    duringRun = async (opts) => {
      seen.push(opts.editingAllowed());
    };
    await chat();
    expect(seen).toEqual([false]);
  });

  it("On through the route applies to the next run", async () => {
    await setEditing(true);
    const seen: boolean[] = [];
    duringRun = async (opts) => {
      seen.push(opts.editingAllowed());
    };
    await chat();
    expect(seen).toEqual([true]);
  });

  it("Off through the route, mid-run, revokes that run at once — and On again does not give it back", async () => {
    await setEditing(true);
    const seen: Record<string, boolean> = {};
    duringRun = async (opts) => {
      seen.start = opts.editingAllowed();
      await setEditing(false); // the user unticks the box while the reply is running
      seen.afterOff = opts.editingAllowed();
      await setEditing(true); // …and ticks it again before the model's next tool call
      seen.afterOnAgain = opts.editingAllowed();
    };
    await chat();
    expect(seen).toEqual({ start: true, afterOff: false, afterOnAgain: false });

    // The next message is a new run, and editing is on for it.
    const next: boolean[] = [];
    duringRun = async (opts) => {
      next.push(opts.editingAllowed());
    };
    await chat();
    expect(next).toEqual([true]);
  });

  it("On through the route, mid-run, does not unlock a run that started with it off", async () => {
    const seen: Record<string, boolean> = {};
    duringRun = async (opts) => {
      seen.start = opts.editingAllowed();
      await setEditing(true);
      // The collaborator's closure answers for the live setting and the Off
      // counter; that a chat-tier START is never unlocked is the engine's latch
      // (`runLocalModelTurn`, pinned in editing-tier.test.ts). What must hold
      // here is that the run was started in the chat tier.
      seen.afterOn = opts.editingAllowed();
    };
    await chat();
    expect(seen.start).toBe(false);
  });
});
