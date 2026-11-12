import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANSWERING_CHANGED_NOTICE_KEY,
  answeringFingerprint,
  type CollaboratorDeps,
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import type { AnsweringLocalModel } from "../../../src/server/local-model/config-source.js";
import {
  __flushLocalModelAnnouncedForTests,
  __resetLocalModelAnnouncedForTests,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
  subscribe as subscribeNotifications,
} from "../../../src/server/notifications.js";
import {
  clearStartupNotices,
  getStartupNotices,
  markStartupNoticeDelivered,
} from "../../../src/server/startup-notices.js";

/**
 * The answering-changed notice across restarts (#2404), with the PRODUCTION
 * `announced` wiring (`DEFAULT_COLLABORATOR_DEPS.announced`) over the real
 * record on disk. Only what answers and the registry-change listener are
 * doubles. `restart()` models a new process on the same app-data directory:
 * nothing is remembered but the file.
 *
 * What these pin: a model switched off and on again is announced even when it
 * is the very same model the user was told about before, however many
 * restarts sit between the steps and whether or not a window was open.
 */
describe("answering-changed notice across restarts, production wiring (#2404)", () => {
  const A: AnsweringLocalModel = {
    entryId: "entry-a",
    endpoint: "http://127.0.0.1:11434",
    modelId: "qwen2.5:14b-instruct",
    displayName: "Model A",
  };

  let dir: string;
  let file: string;
  const cell: { now: AnsweringLocalModel | null } = { now: null };
  let listener: (() => void) | null = null;
  let collab: ReturnType<typeof createLocalModelCollaborator> | null = null;
  let closeWindow: (() => void) | null = null;

  const deps = (): CollaboratorDeps => ({
    runTurn: async () => {
      throw new Error("no run is expected in this file");
    },
    resolveConfig: () => null,
    subscribe: () => {},
    unsubscribe: () => {},
    answering: () => cell.now,
    onModelsChanged: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    // The production wiring under test — not a double.
    announced: DEFAULT_COLLABORATOR_DEPS.announced,
  });

  const start = () => {
    collab = createLocalModelCollaborator(deps());
    collab.__startForTests();
  };
  const change = (next: AnsweringLocalModel | null) => {
    cell.now = next;
    if (!listener) throw new Error("onModelsChanged listener was never registered");
    listener();
  };
  const openWindow = () => {
    closeWindow = subscribeNotifications(() => {}, { ownWindow: true });
  };
  const shutWindow = () => {
    closeWindow?.();
    closeWindow = null;
  };
  const restart = async () => {
    await collab?.stop();
    collab = null;
    shutWindow();
    await __flushLocalModelAnnouncedForTests();
    __resetLocalModelAnnouncedForTests(dir);
    resetNotifications();
    clearStartupNotices();
    start();
  };
  const recorded = async (): Promise<string | null> => {
    await __flushLocalModelAnnouncedForTests();
    if (!fs.existsSync(file)) return null;
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { answering: string | null }).answering;
  };
  const answeringNotices = () =>
    getBuffer().filter((n) => n.dedupKey === ANSWERING_CHANGED_NOTICE_KEY);
  const pendingReplay = () =>
    getStartupNotices().filter((n) => n.dedupKey === ANSWERING_CHANGED_NOTICE_KEY);

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-answering-restart-"));
    file = path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    __resetLocalModelAnnouncedForTests(dir);
    resetNotifications();
    clearStartupNotices();
    cell.now = null;
    listener = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await collab?.stop();
    collab = null;
    shutWindow();
    await __flushLocalModelAnnouncedForTests();
    resetNotifications();
    clearStartupNotices();
    __resetLocalModelAnnouncedForTests();
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("the default `none` withdraws the pending replay under the production key", async () => {
    // Announced with no window open: pending, not recorded.
    cell.now = A;
    start();
    expect(pendingReplay()).toHaveLength(1);
    const [pending] = pendingReplay();
    expect(await recorded()).toBeNull();

    // The model stops answering. The replay names a model that no longer
    // answers; left in place, its delivery would record that model as told.
    change(null);
    expect(pendingReplay()).toEqual([]);
    markStartupNoticeDelivered(pending); // a window connecting now is sent nothing…
    expect(await recorded()).toBeNull(); // …and nothing is recorded
  });

  it("told → disabled → re-enabled with no window → restart: announced again", async () => {
    cell.now = A;
    openWindow();
    start();
    expect(answeringNotices()).toHaveLength(1);
    expect(await recorded()).toBe(answeringFingerprint(A));

    change(null); // disabled
    expect(await recorded()).toBeNull();

    shutWindow();
    change({ ...A }); // re-enabled, nobody watching
    expect(answeringNotices()).toHaveLength(2);
    expect(await recorded(), "a notice nobody was sent is not recorded").toBeNull();

    await restart();
    expect(answeringNotices(), "re-raised at start-up").toHaveLength(1);
    expect(pendingReplay(), "and held for the first window").toHaveLength(1);
    expect(await recorded()).toBeNull();

    // The window finally connects and is sent the replay: now it is told.
    markStartupNoticeDelivered(pendingReplay()[0]);
    expect(await recorded()).toBe(answeringFingerprint(A));
    await restart();
    expect(answeringNotices(), "told: a further restart is silent").toEqual([]);
  });

  it("told → disabled → RESTART → re-enabled with no window → restart: announced again", async () => {
    cell.now = A;
    openWindow();
    start();
    expect(await recorded()).toBe(answeringFingerprint(A));

    change(null);
    await restart(); // starts with nothing answering
    expect(answeringNotices()).toEqual([]);

    change({ ...A }); // no window
    expect(answeringNotices()).toHaveLength(1);
    await restart();
    expect(answeringNotices()).toHaveLength(1);
    expect(pendingReplay()).toHaveLength(1);
  });

  // The record outlived the model: the clearing write failed, or models.json
  // changed while the server was down. Without the start-up clear, the
  // re-enabled model would match the stale record and start silently.
  it("a stale record is cleared at a start-up with nothing answering, so a later re-enable is announced after a restart", async () => {
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 1, editing: false, answering: answeringFingerprint(A) })}\n`,
    );
    __resetLocalModelAnnouncedForTests(dir);

    cell.now = null;
    start();
    expect(await recorded(), "cleared at start-up").toBeNull();

    change({ ...A }); // re-enabled with no window open
    expect(await recorded()).toBeNull();

    await restart();
    expect(answeringNotices(), "not the silent baseline").toHaveLength(1);
    expect(pendingReplay()).toHaveLength(1);
  });
});
