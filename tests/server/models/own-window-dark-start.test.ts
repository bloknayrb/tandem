import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import {
  __flushLocalModelAnnouncedForTests,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
  LOCAL_MODEL_BASELINE_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import { __resetLocalModelSettingsForTests } from "../../../src/server/models/local-model-settings.js";
import {
  __resetModelRegistryForTests,
  persistModelsFile,
} from "../../../src/server/models/registry.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import { clearStartupNotices, getStartupNotices } from "../../../src/server/startup-notices.js";
import { BYO_MODELS_ENABLED } from "../../../src/shared/constants.js";

/**
 * #2404 R3.2a / R3.4 — "a dark start must never create the marker".
 *
 * This runs the REAL dark start: the production collaborator, with its
 * production dependencies, started through `start()` (the gated entry point
 * `src/server/index.ts` calls) over an app-data directory that already holds a
 * `models.json` with a local model that would answer. If `start()` lost its
 * `BYO_MODELS_ENABLED` return it would wire, take the baseline and write both
 * files; this fails then. (The prime's gate in `index.ts` is pinned from source
 * by `production-wiring.test.ts`.)
 */
describe("a dark start of the local-model collaborator touches nothing (#2404)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-dark-start-"));
    __resetModelRegistryForTests(dir);
    __resetLocalModelSettingsForTests(dir);
    resetNotifications();
    clearStartupNotices();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await __flushLocalModelAnnouncedForTests();
    __resetModelRegistryForTests();
    __resetLocalModelSettingsForTests();
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("the flag is off in this build (the anchor: this file describes the dark state)", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  it("start() with a saved local model present writes no record and no marker, and raises nothing", async () => {
    await persistModelsFile({
      schemaVersion: 1,
      models: [
        {
          id: "m-1",
          provider: "local-ollama",
          displayName: "Local",
          modelId: "qwen2.5:14b",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        },
      ],
      defaultModelId: "m-1",
    });
    const before = fs.readdirSync(dir).sort();
    expect(before.some((name) => name.endsWith(".json"))).toBe(true);

    const collab = createLocalModelCollaborator(DEFAULT_COLLABORATOR_DEPS);
    collab.start();
    await __flushLocalModelAnnouncedForTests();
    try {
      expect(fs.readdirSync(dir).sort()).toEqual(before);
      expect(fs.existsSync(path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME))).toBe(false);
      expect(fs.existsSync(path.join(dir, LOCAL_MODEL_BASELINE_FILE_NAME))).toBe(false);
      expect(getStartupNotices()).toEqual([]);
      expect(getBuffer()).toEqual([]);
    } finally {
      await collab.stop();
    }
  });

  it("the same start through the test seam (lit wiring) DOES write both: the test above is not vacuous", async () => {
    await persistModelsFile({
      schemaVersion: 1,
      models: [
        {
          id: "m-1",
          provider: "local-ollama",
          displayName: "Local",
          modelId: "qwen2.5:14b",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        },
      ],
      defaultModelId: "m-1",
    });
    const collab = createLocalModelCollaborator(DEFAULT_COLLABORATOR_DEPS);
    collab.__startForTests();
    await __flushLocalModelAnnouncedForTests();
    try {
      expect(fs.existsSync(path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME))).toBe(true);
      expect(fs.existsSync(path.join(dir, LOCAL_MODEL_BASELINE_FILE_NAME))).toBe(true);
    } finally {
      await collab.stop();
    }
  });
});
