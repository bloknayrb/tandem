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
  type CollaboratorDeps,
  createLocalModelCollaborator,
  UNUSABLE_NOTICE,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";
import {
  answeringLocalModel,
  diagnoseLocalModel,
  resolveLocalModelConfig,
} from "../../../src/server/local-model/config-source.js";
import type { LoopResult, RunTurnOpts } from "../../../src/server/local-model/index.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { registerModelsRoutes } from "../../../src/server/models/api-routes.js";
import {
  __resetModelRegistryForTests,
  getModelsEtag,
  onModelsFileChanged,
} from "../../../src/server/models/registry.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import { clearStartupNotices, getStartupNotices } from "../../../src/server/startup-notices.js";
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
  type ModelsEntry,
  type ModelsFile,
} from "../../../src/shared/models/contract.js";
import { withInternal } from "../../../src/shared/origins.js";

/**
 * #1123 R1: a model saved through the REAL `POST /api/models` route reaches the
 * collaborator loop on the next chat event — no restart, no re-creation of the
 * collaborator, and no injected resolver standing in for the registry.
 *
 * Everything between the HTTP request and `runTurn` is production code: the
 * route, the Zod parse, the store write into a temp app-data dir, the registry
 * cache replacement and its change listeners, `resolveLocalModelConfig`,
 * `diagnoseLocalModel` and the collaborator's own per-event resolve. Only the
 * model call (`runTurn`) and the event-queue subscription are doubles.
 */

const DOC = "doc-live-config";
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

function entry(over: Partial<ModelsEntry> = {}): ModelsEntry {
  return {
    id: "m-1",
    provider: "local-ollama",
    displayName: "Local One",
    modelId: "qwen2.5:14b-instruct",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
    ...over,
  };
}

function file(models: ModelsEntry[], defaultModelId: string | null): ModelsFile {
  return { schemaVersion: 1, models, defaultModelId };
}

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

describe("collaborator — a model saved through POST /api/models reaches the loop (#1123 R1)", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;
  let collab: ReturnType<typeof createLocalModelCollaborator>;
  /** The callback the collaborator registered with the (stub) event queue. */
  let deliver: (e: TandemEvent) => void;
  let runs: RunTurnOpts[];
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let seq = 0;

  /** Save a whole registry file the way the Settings client does. */
  async function save(next: ModelsFile): Promise<void> {
    const res = await fetch(`${baseUrl}${API_MODELS}`, {
      method: "POST",
      headers: { Origin: `http://${TAURI_HOSTNAME}`, "content-type": "application/json" },
      body: JSON.stringify({ file: next, ifMatch: getModelsEtag() }),
    });
    const body = (await res.json()) as { etag?: string };
    // A refused save would make every "nothing ran" assertion below vacuous.
    expect(res.status).toBe(200);
    expect(body.etag).toBe(getModelsEtag());
  }

  /** Deliver `count` user chat messages through the registered subscriber. */
  async function chat(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      const messageId = `live-${seq++}`;
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
  }

  const seenConfigs = (): Array<Pick<LocalModelConfig, "endpoint" | "modelId">> =>
    runs.map((r) => ({ endpoint: r.config.endpoint, modelId: r.config.modelId }));

  /**
   * Wire a collaborator over the REAL registry-backed seams. `extra` adds a
   * seam the default set below leaves out (the answering-changed notice has
   * its own describe, so the tests above it can keep asserting an empty tray).
   */
  function wireCollaborator(extra: Partial<CollaboratorDeps> = {}): void {
    let registered: ((e: TandemEvent) => void) | null = null;
    collab = createLocalModelCollaborator({
      runTurn: async (opts) => {
        runs.push(opts);
        return cleanResult();
      },
      // The REAL registry-backed seams — the point of this file.
      resolveConfig: resolveLocalModelConfig,
      diagnose: diagnoseLocalModel,
      onModelsChanged: onModelsFileChanged,
      subscribe: (cb) => {
        registered = cb;
      },
      unsubscribe: () => {},
      aiRefusal: () => null,
      ...extra,
    });
    collab.__startForTests();
    if (!registered) throw new Error("the collaborator did not subscribe");
    deliver = registered;
  }

  beforeEach(async () => {
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

    // The registry reset also drops every change listener, so it must come
    // BEFORE the collaborator is wired.
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-live-config-"));
    __resetModelRegistryForTests(tmpDir);

    // The breadcrumb `noticeUnusable` prints, and nothing else, goes to stderr.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

    runs = [];
    wireCollaborator();

    const app = express();
    app.use(express.json());
    registerModelsRoutes(app, passthrough, passthrough, {
      keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS, backend: memoryBackend() }),
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
    await collab.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetModelRegistryForTests();
    removeDoc(DOC);
    clearStartupNotices();
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("nothing saved: a chat runs nothing and says nothing", async () => {
    await chat(2);
    expect(runs).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("saving an enabled default local model: the NEXT chat's run gets its endpoint and model id", async () => {
    await chat(); // before the save: inert
    expect(runs).toEqual([]);

    await save(file([entry()], "m-1"));
    await chat();

    expect(seenConfigs()).toEqual([
      { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct" },
    ]);
    expect(runs[0].config.transport).toBe("v1");
    expect(runs[0].config.agentIdentity).toEqual({
      provider: "local-ollama",
      displayName: "Local One",
    });
    expect(getBuffer()).toEqual([]);
  });

  it("changing the endpoint, the model id, then the default: each next run sees the saved value", async () => {
    await save(file([entry()], "m-1"));
    await chat();

    await save(file([entry({ endpoint: "http://localhost:8080" })], "m-1"));
    await chat();

    await save(file([entry({ endpoint: "http://localhost:8080", modelId: "llama3.1:8b" })], "m-1"));
    await chat();

    const second = entry({
      id: "m-2",
      provider: "local-llamacpp",
      displayName: "Local Two",
      modelId: "phi-4",
      endpoint: "http://[::1]:9090",
    });
    await save(
      file([entry({ endpoint: "http://localhost:8080", modelId: "llama3.1:8b" }), second], "m-2"),
    );
    await chat();

    expect(seenConfigs()).toEqual([
      { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct" },
      { endpoint: "http://localhost:8080", modelId: "qwen2.5:14b-instruct" },
      { endpoint: "http://localhost:8080", modelId: "llama3.1:8b" },
      { endpoint: "http://[::1]:9090", modelId: "phi-4" },
    ]);
    expect(runs[3].config.agentIdentity).toEqual({
      provider: "local-llamacpp",
      displayName: "Local Two",
    });
    expect(getBuffer()).toEqual([]);
  });

  it("disabling the default: no run and no notice; re-enabling it: a run again", async () => {
    await save(file([entry()], "m-1"));
    await chat();
    expect(runs).toHaveLength(1);

    await save(file([entry({ enabled: false })], "m-1"));
    await chat(3);
    expect(runs).toHaveLength(1);
    expect(getBuffer()).toEqual([]);

    await save(file([entry()], "m-1"));
    await chat();
    expect(runs).toHaveLength(2);
    expect(getBuffer()).toEqual([]);
  });

  for (const [label, endpoint] of [
    ["https on loopback", "https://127.0.0.1:23456"],
    ["a LAN address", "http://192.168.1.20:23456"],
    ["an address with a user name and password", "http://someuser:hunter2pw@127.0.0.1:23457"],
  ] as const) {
    it(`a default whose endpoint is rejected (${label}): exactly one notice over several chats`, async () => {
      const modelId = "distinctive-model-id:99b";
      await save(file([entry({ endpoint, modelId })], "m-1"));

      await chat(4);

      expect(runs).toEqual([]);
      const notes = getBuffer();
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
      expect(notes[0].severity).toBe("warning");
      expect("dedupKey" in notes[0]).toBe(false);
      // What the user saved never reaches the notice or the stderr breadcrumb.
      const told = [
        notes[0].message,
        ...errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")),
      ];
      for (const text of told) {
        expect(text).not.toContain(endpoint);
        expect(text).not.toContain(new URL(endpoint).host);
        expect(text).not.toContain(modelId);
        expect(text).not.toContain("hunter2pw");
        expect(text).not.toContain("someuser");
      }
      // Not chat: the notice went to the browser's notify stream only.
      expect(chatMap().size).toBe(0);
    });
  }

  it("one rejected endpoint replaced by another is a new state: a second notice, once", async () => {
    await save(file([entry({ endpoint: "https://127.0.0.1:11434" })], "m-1"));
    await chat(2);
    expect(getBuffer()).toHaveLength(1);

    await save(file([entry({ endpoint: "http://192.168.1.20:11434" })], "m-1"));
    await chat(3);

    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.message)).toEqual([
      UNUSABLE_NOTICE["endpoint-rejected"],
      UNUSABLE_NOTICE["endpoint-rejected"],
    ]);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(runs).toEqual([]);
  });

  it("a rejected endpoint that is corrected: the next chat runs on the corrected one", async () => {
    await save(file([entry({ endpoint: "https://127.0.0.1:11434" })], "m-1"));
    await chat(2);
    expect(getBuffer()).toHaveLength(1);

    await save(file([entry()], "m-1"));
    await chat();

    expect(seenConfigs()).toEqual([
      { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct" },
    ]);
    expect(getBuffer()).toHaveLength(1);
  });

  it("a default with no endpoint saved: exactly one notice with the no-endpoint text", async () => {
    const { endpoint: _dropped, ...noEndpoint } = entry();
    await save(file([noEndpoint], "m-1"));

    await chat(3);

    expect(runs).toEqual([]);
    const notes = getBuffer();
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toBe(UNUSABLE_NOTICE["no-endpoint"]);
  });

  it("ONE enabled local model with NO default: the next chat runs on it, and nothing is said", async () => {
    await chat(); // before the save: inert
    expect(runs).toEqual([]);

    // Adding a model from Settings does not mark it Default. A sole enabled
    // local model answers unmarked.
    await save(file([entry()], null));
    await chat(2);

    expect(seenConfigs()).toEqual([
      { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct" },
      { endpoint: "http://127.0.0.1:11434", modelId: "qwen2.5:14b-instruct" },
    ]);
    expect(runs[0].config.agentIdentity).toEqual({
      provider: "local-ollama",
      displayName: "Local One",
    });
    expect(getBuffer()).toEqual([]);
  });

  it("a sole enabled local model with NO default still has its endpoint checked", async () => {
    await save(file([entry({ endpoint: "http://192.168.1.20:11434" })], null));
    await chat(3);

    expect(runs).toEqual([]);
    expect(getBuffer()).toHaveLength(1);
    expect(getBuffer()[0].message).toBe(UNUSABLE_NOTICE["endpoint-rejected"]);
  });

  it("a disabled DEFAULT is not overridden by a spare enabled local model: silent", async () => {
    await save(file([entry({ enabled: false }), entry({ id: "m-2" })], "m-1"));
    await chat(2);
    expect(runs).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  const SECOND = entry({
    id: "m-2",
    displayName: "Local Two",
    modelId: "phi-4",
    endpoint: "http://localhost:8080",
  });

  it("TWO enabled local models with NO default: exactly one notice; mark one: a run; clear it again: a second notice", async () => {
    await save(file([entry(), SECOND], null));
    await chat(3);

    expect(runs).toEqual([]);
    expect(getBuffer()).toHaveLength(1);
    expect(getBuffer()[0].message).toBe(UNUSABLE_NOTICE["no-default-chosen"]);
    expect(getBuffer()[0].message).toContain("none of them was marked Default");

    await save(file([entry(), SECOND], "m-2"));
    await chat();
    expect(seenConfigs()).toEqual([{ endpoint: "http://localhost:8080", modelId: "phi-4" }]);
    expect(getBuffer()).toHaveLength(1);

    await save(file([entry(), SECOND], null));
    await chat(3);

    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes[1].message).toBe(UNUSABLE_NOTICE["no-default-chosen"]);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(runs).toHaveLength(1);
  });

  it("two local models: default set and cleared again with NO chat in between: still a second notice", async () => {
    await save(file([entry(), SECOND], null));
    await chat(2);
    expect(getBuffer()).toHaveLength(1);

    // Two saves, no chat: only the registry's change listener can tell the
    // collaborator that the state it reported was fixed in the meantime.
    await save(file([entry(), SECOND], "m-1"));
    await save(file([entry(), SECOND], null));
    expect(getBuffer()).toHaveLength(1); // a save alone tells the user nothing

    await chat(3);

    const notes = getBuffer();
    expect(notes).toHaveLength(2);
    expect(notes[1].message).toBe(UNUSABLE_NOTICE["no-default-chosen"]);
    expect(notes[1].id).not.toBe(notes[0].id);
    expect(runs).toEqual([]);
  });

  it("a save that leaves the broken state as it was does not repeat the notice", async () => {
    await save(file([entry(), SECOND], null));
    await chat(2);
    expect(getBuffer()).toHaveLength(1);

    // Still no default; only an unrelated field changed. The file is new, the
    // state is not.
    await save(file([entry({ displayName: "Renamed" }), SECOND], null));
    await chat(2);
    // Adding a third local model while still default-less is not a new state either.
    await save(file([entry({ displayName: "Renamed" }), SECOND, entry({ id: "m-3" })], null));
    await chat(2);

    expect(getBuffer()).toHaveLength(1);
    expect(runs).toEqual([]);
  });

  it("no default and only a disabled local model: silent", async () => {
    await save(file([entry({ enabled: false })], null));
    await chat(2);
    expect(runs).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  describe("the answering-changed notice, through the real route (#2404)", () => {
    const answeringNotes = () =>
      getBuffer().filter((n) => n.dedupKey === ANSWERING_CHANGED_NOTICE_KEY);

    beforeEach(async () => {
      // Re-wire with the real `answeringLocalModel` seam added. The baseline is
      // taken here, at wire, over an empty registry: nothing would answer.
      await collab.stop();
      wireCollaborator({ answering: answeringLocalModel });
      expect(getBuffer()).toEqual([]);
    });

    it("saving the first model, with no chat at all: one notice, also registered for replay", async () => {
      await save(file([entry()], "m-1"));

      const notes = answeringNotes();
      expect(getBuffer()).toHaveLength(1);
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe(
        answeringChangedNotice({
          entryId: "m-1",
          endpoint: "http://127.0.0.1:11434",
          modelId: "qwen2.5:14b-instruct",
          displayName: "Local One",
        }),
      );
      expect(notes[0].message).toContain('"Local One"');
      expect(notes[0].severity).toBe("warning");
      expect(getStartupNotices()).toEqual([notes[0]]);
      expect(chatMap().size).toBe(0);
      expect(runs).toEqual([]);
    });

    it("an unmarked sole local model is announced too: it is what would answer", async () => {
      await save(file([entry()], null));
      expect(answeringNotes()).toHaveLength(1);
      // Marking it Default changes neither the entry nor where it points.
      await save(file([entry()], "m-1"));
      expect(answeringNotes()).toHaveLength(1);
    });

    it("endpoint change: another; rename: none; disable and re-enable: none; another default: one", async () => {
      const endpoints = ["http://127.0.0.1:11434", "http://localhost:8080", "http://[::1]:9090"];
      const modelIds = ["qwen2.5:14b-instruct", "phi-4"];

      await save(file([entry()], "m-1"));
      expect(answeringNotes()).toHaveLength(1);

      await save(file([entry({ endpoint: endpoints[1] })], "m-1"));
      expect(answeringNotes()).toHaveLength(2);

      await save(file([entry({ endpoint: endpoints[1], displayName: "Renamed" })], "m-1"));
      expect(answeringNotes()).toHaveLength(2);

      await save(
        file([entry({ endpoint: endpoints[1], displayName: "Renamed", enabled: false })], "m-1"),
      );
      expect(answeringNotes()).toHaveLength(2);
      await save(file([entry({ endpoint: endpoints[1], displayName: "Renamed" })], "m-1"));
      expect(answeringNotes()).toHaveLength(2);

      const first = entry({ endpoint: endpoints[1], displayName: "Renamed" });
      const second = entry({
        id: "m-2",
        provider: "local-llamacpp",
        displayName: "Local Two",
        modelId: modelIds[1],
        endpoint: endpoints[2],
      });
      // Adding a second model while the default stays put changes nothing…
      await save(file([first, second], "m-1"));
      expect(answeringNotes()).toHaveLength(2);
      // …switching the default to it does.
      await save(file([first, second], "m-2"));

      const notes = answeringNotes();
      expect(notes).toHaveLength(3);
      expect(getBuffer()).toHaveLength(3); // and nothing else was said
      expect(new Set(notes.map((n) => n.id)).size).toBe(3);
      expect(notes[2].message).toContain('"Local Two"');
      // One replay entry, the latest: the key replaces rather than stacks.
      expect(getStartupNotices()).toEqual([notes[2]]);
      for (const n of notes) {
        for (const endpoint of endpoints) {
          expect(n.message).not.toContain(endpoint);
          expect(n.message).not.toContain(new URL(endpoint).host);
        }
        for (const modelId of modelIds) expect(n.message).not.toContain(modelId);
        expect(n.message).not.toMatch(/https?:\/\//);
      }
      expect(chatMap().size).toBe(0);
    });

    it("the next chat runs on what was announced", async () => {
      await save(file([entry()], "m-1"));
      await save(file([entry({ endpoint: "http://localhost:8080" })], "m-1"));
      await chat();
      expect(seenConfigs()).toEqual([
        { endpoint: "http://localhost:8080", modelId: "qwen2.5:14b-instruct" },
      ]);
      expect(answeringNotes()).toHaveLength(2);
    });
  });
});
