import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BROKEN_BACKUPS_DIR_NAME } from "../../../src/server/integrations/storage.js";
import { emptyModelsFile } from "../../../src/server/models/schema.js";
import {
  createModelStore,
  MODELS_BROKEN_BACKUP_PREFIX,
  MODELS_FILE_NAME,
} from "../../../src/server/models/store.js";
import type { ModelsFile } from "../../../src/shared/models/contract.js";

const localEntry = {
  id: "m-1",
  provider: "local-ollama" as const,
  displayName: "Local Qwen",
  modelId: "qwen2.5:14b-instruct",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

function file(over: Partial<ModelsFile> = {}): ModelsFile {
  return { schemaVersion: 1, models: [localEntry], defaultModelId: "m-1", ...over };
}

describe("createModelStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-models-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("requires an absolute basePath", () => {
    expect(() => createModelStore("")).toThrow(/basePath is required/);
    expect(() => createModelStore("relative/path")).toThrow(/must be absolute/);
  });

  it("filePath joins basePath with models.json", () => {
    expect(createModelStore(tmpDir).filePath).toBe(path.join(tmpDir, MODELS_FILE_NAME));
  });

  it("read() returns empty when the file is absent", async () => {
    expect(await createModelStore(tmpDir).read()).toEqual(emptyModelsFile());
  });

  it("write() then read() round-trips a populated registry", async () => {
    const store = createModelStore(tmpDir);
    await store.write(file());
    expect(await store.read()).toEqual(file());
  });

  it("malformed JSON → backup + empty (never throws)", async () => {
    await fs.promises.writeFile(path.join(tmpDir, MODELS_FILE_NAME), "{not json", "utf8");
    const store = createModelStore(tmpDir);
    await expect(store.read()).resolves.toEqual(emptyModelsFile());
    const backups = await fs.promises.readdir(path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME));
    expect(backups.some((n) => n.startsWith(MODELS_BROKEN_BACKUP_PREFIX))).toBe(true);
  });

  it("version-too-new → backup + empty, does NOT throw (resolver has no error channel)", async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, MODELS_FILE_NAME),
      JSON.stringify({ schemaVersion: 999, models: [], defaultModelId: null }),
      "utf8",
    );
    const store = createModelStore(tmpDir);
    await expect(store.read()).resolves.toEqual(emptyModelsFile());
  });

  it("post-parse Zod failure → backup + empty (never throws)", async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, MODELS_FILE_NAME),
      JSON.stringify({ schemaVersion: 1, models: [{ id: "x", provider: "not-a-provider" }] }),
      "utf8",
    );
    const store = createModelStore(tmpDir);
    await expect(store.read()).resolves.toEqual(emptyModelsFile());
  });

  it("write() rejects an unknown key (.strict) — no plaintext key can persist", async () => {
    const store = createModelStore(tmpDir);
    const dirty = {
      schemaVersion: 1,
      models: [{ ...localEntry, apiKey: "sk-PLAINTEXT-should-be-rejected" }],
      defaultModelId: "m-1",
    } as unknown as ModelsFile;
    await expect(store.write(dirty)).rejects.toThrow();
  });

  it("dangling defaultModelId is cleared to null on read", async () => {
    const store = createModelStore(tmpDir);
    // Write a valid file, then hand-edit defaultModelId to a missing id.
    await fs.promises.writeFile(
      path.join(tmpDir, MODELS_FILE_NAME),
      JSON.stringify({ schemaVersion: 1, models: [localEntry], defaultModelId: "ghost" }),
      "utf8",
    );
    const read = await store.read();
    expect(read.defaultModelId).toBeNull();
    expect(read.models).toHaveLength(1);
  });
});
