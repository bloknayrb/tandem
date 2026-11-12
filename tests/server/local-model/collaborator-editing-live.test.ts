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
  ANSWERING_CHANGED_NOTICE_KEY,
  answeringChangedNotice,
  answeringFingerprint,
  type CollaboratorDeps,
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import {
  answeringLocalModel,
  diagnoseLocalModel,
  resolveLocalModelConfig,
} from "../../../src/server/local-model/config-source.js";
import type { LoopResult, RunTurnOpts } from "../../../src/server/local-model/index.js";
import { runLocalModelTurn } from "../../../src/server/local-model/index.js";
import { EDITING_OFF_MESSAGE, READ_TOOL_NAMES } from "../../../src/server/local-model/tools.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { registerModelsRoutes } from "../../../src/server/models/api-routes.js";
import {
  __flushLocalModelAnnouncedForTests,
  answeringWasAnnounced,
  editingOnWasAnnounced,
  LOCAL_MODEL_BASELINE_FILE_NAME,
  SETTINGS_CHANGED_NOTICE,
  SETTINGS_CHANGED_NOTICE_KEY,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  EDITING_ON_NOTICE,
  EDITING_ON_NOTICE_KEY,
  localModelEditingState,
} from "../../../src/server/models/local-model-settings.js";
import { createOwnWindowPolicy } from "../../../src/server/models/own-window.js";
import {
  __resetModelRegistryForTests,
  getModelsEtag,
  onModelsFileChanged,
} from "../../../src/server/models/registry.js";
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
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
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
import type { ChatMessage } from "../../../src/shared/types.js";

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

/**
 * How the writes in this file reach the routes (#2404). The routes accept a
 * request only from Tandem's own window, or from the one origin the development
 * allowance names. The DEFAULT here is the allowance origin, because that is
 * the path on which a change is still announced as it happens; a test of the
 * user's own change sets `writeOrigin` to `OWN_WINDOW_ORIGIN`.
 */
const ALLOWANCE_ORIGIN = "http://127.0.0.1:5173";
const OWN_WINDOW_ORIGIN = `http://${TAURI_HOSTNAME}`;
let writeOrigin = ALLOWANCE_ORIGIN;

describe("production wiring of the collaborator's seams (#1123)", () => {
  it("DEFAULT_COLLABORATOR_DEPS wires every seam that fails closed when absent", () => {
    expect(DEFAULT_COLLABORATOR_DEPS.runTurn).toBe(runLocalModelTurn);
    expect(DEFAULT_COLLABORATOR_DEPS.resolveConfig).toBe(resolveLocalModelConfig);
    expect(DEFAULT_COLLABORATOR_DEPS.diagnose).toBe(diagnoseLocalModel);
    expect(DEFAULT_COLLABORATOR_DEPS.editingState).toBe(localModelEditingState);
    expect(DEFAULT_COLLABORATOR_DEPS.onModelsChanged).toBe(onModelsFileChanged);
    expect(DEFAULT_COLLABORATOR_DEPS.answering).toBe(answeringLocalModel);
    // Round 3: absent, the model found at start-up is the silent baseline.
    expect(DEFAULT_COLLABORATOR_DEPS.announced).toBeDefined();
    expect(DEFAULT_COLLABORATOR_DEPS.announced?.wasAnnounced).toBe(answeringWasAnnounced);
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

  const headersNow = () => ({ Origin: writeOrigin, "content-type": "application/json" });

  async function setEditing(editing: boolean): Promise<void> {
    const res = await fetch(`${baseUrl}${API_MODELS_LOCAL_SETTINGS}`, {
      method: "POST",
      headers: headersNow(),
      body: JSON.stringify({ editing }),
    });
    // A refused switch would make every assertion below vacuous.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ editing, persisted: true });
  }

  /** Production's seams, with only what `over` names (and the queue) swapped. */
  function wireCollaborator(over: Partial<CollaboratorDeps>): void {
    let registered: ((e: TandemEvent) => void) | null = null;
    collab = createLocalModelCollaborator({
      ...DEFAULT_COLLABORATOR_DEPS,
      subscribe: (cb) => {
        registered = cb;
      },
      unsubscribe: () => {},
      aiRefusal: () => null,
      ...over,
    });
    collab.__startForTests();
    if (!registered) throw new Error("the collaborator did not subscribe");
    deliver = registered;
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
    writeOrigin = ALLOWANCE_ORIGIN;
    resetQueue();
    resetNotifications();
    clearStartupNotices();
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => {
      ctrl.getMap(Y_MAP_CHAT).clear();
      ctrl.getMap(Y_MAP_CHAT_STREAM).clear();
      ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE); // unset reads as Tandem
    });

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-editing-live-"));
    // Not the first start with local models switched on (that one takes the
    // model it finds as the baseline, silently): every wire in this file is a
    // LATER start, so the marker is already on disk (#2404).
    fs.writeFileSync(path.join(tmpDir, LOCAL_MODEL_BASELINE_FILE_NAME), '{"version":1}\n', "utf8");
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
    wireCollaborator({
      runTurn: async (opts) => {
        await duringRun(opts);
        return cleanResult();
      },
    });

    const app = express();
    app.use(express.json());
    registerModelsRoutes(app, passthrough, passthrough, {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend: memoryBackend() }),
      ownWindow: createOwnWindowPolicy({
        getBound: () => null,
        allowance: ALLOWANCE_ORIGIN,
        // The "own window" in this file is the desktop WebView.
        desktop: true,
      }),
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
      headers: headersNow(),
      body: JSON.stringify({ file: REGISTRY, ifMatch: getModelsEtag() }),
    });
    expect(saved.status).toBe(200);
    // Saving the first model is itself announced (the answering-changed notice,
    // pinned in collaborator-live-config.test.ts). Start every test below from
    // an empty tray and an empty replay list, so each counts only its own.
    expect(getBuffer()).toHaveLength(1);
    resetNotifications();
    clearStartupNotices();
  });

  afterEach(async () => {
    await collab.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The announced-record is written behind the request that caused it; let
    // it land before the directory is removed.
    await __flushLocalModelAnnouncedForTests();
    resetNotifications();
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
    removeDoc(DOC);
    clearStartupNotices();
    vi.unstubAllGlobals();
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
    // The REAL engine for this one: `runLocalModelTurn`, its chat client and
    // `dispatch`. Only the model endpoint's HTTP answers are scripted; every
    // request to this test's own server goes to the real fetch.
    await collab.stop();
    wireCollaborator({});
    expect(DEFAULT_COLLABORATOR_DEPS.runTurn).toBe(runLocalModelTurn);
    // This second wire finds a saved model that the record does not name (it
    // was saved through the allowance origin and no notify stream is open in
    // this file), so the start-up notice is raised at wire rather than the
    // model being taken as the baseline.
    const STARTUP_MODEL_NOTICE = SETTINGS_CHANGED_NOTICE;
    expect(getBuffer().map((n) => n.message)).toEqual([STARTUP_MODEL_NOTICE]);

    // `Response` in this file is Express's type; the model answers with fetch's.
    const sse = (delta: unknown): globalThis.Response =>
      new globalThis.Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\ndata: [DONE]\n`);
    const toolCall = (name: string, args: Record<string, unknown>): globalThis.Response =>
      sse({
        tool_calls: [
          { index: 0, id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } },
        ],
      });
    const REPLY = "This document has a title and one line of body text.";

    interface ModelRequest {
      url: string;
      tools: string[];
      messages: { role: string; content: string }[];
    }
    const requests: ModelRequest[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("http://127.0.0.1:11434/")) return realFetch(input, init);
      const index = requests.length;
      const body = JSON.parse(String(init?.body)) as {
        tools?: { function: { name: string } }[];
        messages: { role: string; content: string }[];
      };
      requests.push({
        url,
        tools: (body.tools ?? []).map((t) => t.function.name),
        messages: body.messages,
      });
      if (index === 0) return toolCall("get_outline", {});
      if (index === 1) {
        // "While the model is thinking": the box is ticked, through the route.
        await setEditing(true);
        expect(localModelEditingState().enabled).toBe(true);
        // A forged write: the tool was never offered, and the quote is real.
        return toolCall("comment_on_quote", { quoted_text: "Body.", comment: "forged" });
      }
      return sse({ content: REPLY });
    });

    await chat();

    const readTools = [...READ_TOOL_NAMES].sort();
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.url === "http://127.0.0.1:11434/v1/chat/completions")).toBe(
      true,
    );
    // Only the reading tools were offered, before and after the switch…
    expect([...requests[0].tools].sort()).toEqual(readTools);
    expect([...requests[1].tools].sort()).toEqual(readTools);
    // …and once the forged write was refused, no tools at all.
    expect(requests[2].tools).toEqual([]);
    const toolResults = requests[2].messages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(toolResults[1].content)).toMatchObject({
      error: "EDITING_OFF",
      message: EDITING_OFF_MESSAGE,
    });

    // Nothing was written to the document, although editing reads ON now.
    const ydoc = getOrCreateDocument(DOC);
    expect(localModelEditingState().enabled).toBe(true);
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);

    // The run still delivered its text reply, and raised nothing of its own:
    // after the wire's start-up notice, the only notification is the route's
    // "switched on" notice (the switch came through the allowance origin, so
    // it is announced as #2403 built it).
    const chatRows = [
      ...getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).values(),
    ] as ChatMessage[];
    expect(chatRows.map((m) => m.text)).toEqual([REPLY]);
    expect(chatRows[0].author).toBe("claude");
    expect(getBuffer().map((n) => n.message)).toEqual([STARTUP_MODEL_NOTICE, EDITING_ON_NOTICE]);
  });

  describe("the model found at wire, against the real announced-record (#2404, round 3)", () => {
    const MODEL = {
      entryId: "m-1",
      endpoint: "http://127.0.0.1:11434",
      modelId: "qwen2.5:14b-instruct",
      displayName: "Local One",
    };
    /** The live notice: a save in this run that was not from Tandem's own window. */
    const answeringNotes = () =>
      getBuffer().filter((n) => n.dedupKey === ANSWERING_CHANGED_NOTICE_KEY);
    /** The start-up notice: a wire that finds a model the record does not name. */
    const startupNotes = () =>
      getBuffer().filter((n) => n.dedupKey === SETTINGS_CHANGED_NOTICE_KEY);

    it("saved with no browser connected: a new wire raises the start-up notice, and registers it for replay", async () => {
      expect(answeringWasAnnounced(answeringFingerprint(MODEL))).toBe(false);

      await collab.stop();
      wireCollaborator({});

      const notes = startupNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ message: SETTINGS_CHANGED_NOTICE, severity: "warning" });
      expect(getStartupNotices()).toEqual(notes);
      expect(answeringNotes()).toEqual([]);
      // Raised, but still written to no stream: a third wire says it again.
      expect(answeringWasAnnounced(answeringFingerprint(MODEL))).toBe(false);
      await collab.stop();
      wireCollaborator({});
      expect(startupNotes()).toHaveLength(2);
    });

    it("saved while a browser is connected: a new wire is silent", async () => {
      const seen: string[] = [];
      subscribeNotifications((n) => seen.push(n.message), { ownWindow: true });
      const moved = { ...MODEL, endpoint: "http://127.0.0.1:11435" };
      const saved = await fetch(`${baseUrl}${API_MODELS}`, {
        method: "POST",
        headers: headersNow(),
        body: JSON.stringify({
          file: { ...REGISTRY, models: [{ ...REGISTRY.models[0], endpoint: moved.endpoint }] },
          ifMatch: getModelsEtag(),
        }),
      });
      expect(saved.status).toBe(200);
      expect(seen).toEqual([answeringChangedNotice(moved)]);
      expect(answeringWasAnnounced(answeringFingerprint(moved))).toBe(true);
      // The model it replaced is no longer "the one a browser was told about".
      expect(answeringWasAnnounced(answeringFingerprint(MODEL))).toBe(false);

      await collab.stop();
      wireCollaborator({});
      expect(answeringNotes()).toHaveLength(1); // only the save's own
      expect(startupNotes()).toEqual([]);
      expect(seen).toHaveLength(1);
    });
  });

  describe("switching on is announced (#2404)", () => {
    const onNotes = () => getBuffer().filter((n) => n.message === EDITING_ON_NOTICE);

    it("ON through the route: exactly one notification, also registered for replay", async () => {
      expect(getStartupNotices()).toEqual([]);
      await setEditing(true);

      expect(getBuffer()).toHaveLength(1);
      const [note] = onNotes();
      expect(note).toMatchObject({
        type: "general-error",
        severity: "warning",
        message: EDITING_ON_NOTICE,
        dedupKey: EDITING_ON_NOTICE_KEY,
      });
      expect(getStartupNotices()).toEqual([note]);
    });

    it("ON from Tandem's own window is the user's own: no notification, and recorded at once", async () => {
      writeOrigin = OWN_WINDOW_ORIGIN;
      await setEditing(true);

      expect(onNotes()).toEqual([]);
      expect(getBuffer()).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
      expect(editingOnWasAnnounced()).toBe(true);
    });

    it("a second ON while already on says nothing", async () => {
      await setEditing(true);
      const [first] = onNotes();
      await setEditing(true);

      expect(getBuffer()).toHaveLength(1);
      expect(getStartupNotices()).toEqual([first]);
    });

    it("OFF withdraws the replay and raises no notification", async () => {
      await setEditing(true);
      expect(getStartupNotices()).toHaveLength(1);
      await setEditing(false);

      expect(getStartupNotices()).toEqual([]);
      expect(getBuffer()).toHaveLength(1); // still just the ON notice
      expect(onNotes()).toHaveLength(1);
    });

    it("OFF with nothing switched on raises nothing; ON again after an OFF is announced again", async () => {
      await setEditing(false);
      expect(getBuffer()).toEqual([]);
      expect(getStartupNotices()).toEqual([]);

      await setEditing(true);
      await setEditing(false);
      await setEditing(true);

      const notes = onNotes();
      expect(getBuffer()).toHaveLength(2);
      expect(notes).toHaveLength(2);
      expect(notes[1].id).not.toBe(notes[0].id);
      expect(getStartupNotices()).toEqual([notes[1]]);
    });
  });
});
