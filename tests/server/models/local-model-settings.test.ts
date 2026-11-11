import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLocalModelSettingsForTests,
  isLocalModelEditingEnabled,
  LOCAL_MODEL_SETTINGS_FILE_NAME,
  localModelEditingState,
  primeLocalModelSettings,
  setLocalModelEditing,
} from "../../../src/server/models/local-model-settings.js";
import {
  __resetModelRegistryForTests,
  onModelsFileChanged,
  persistModelsFile,
  primeModelStoreCache,
} from "../../../src/server/models/registry.js";
import type { ModelsFile } from "../../../src/shared/models/contract.js";

/**
 * `local-model-settings.json` (#1123): the one opt-in that lets a local model
 * comment and suggest. Every case runs against a per-test temp dir.
 *
 * The write is failed by replacing `atomicWriteConfigFile`, never by file
 * permissions, so the cases mean the same thing on Windows and POSIX. Only a
 * write of the settings file is diverted; every other caller of the helper
 * (the Models registry in the last describe) reaches the real one.
 */
type WriteImpl = (
  file: string,
  content: string,
  real: (file: string, content: string) => Promise<void>,
) => Promise<void>;

const writeControl = vi.hoisted(() => ({
  impl: null as unknown,
  calls: [] as string[],
}));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
      const isSettings = file.endsWith("local-model-settings.json");
      if (isSettings) writeControl.calls.push(content);
      const impl = writeControl.impl as WriteImpl | null;
      if (isSettings && impl) return impl(file, content, actual.atomicWriteConfigFile);
      return actual.atomicWriteConfigFile(file, content);
    },
  };
});

function failWrites(impl: WriteImpl): void {
  writeControl.impl = impl;
}

const REJECT: WriteImpl = async () => {
  throw new Error("simulated write failure");
};
/** The bytes reach the disk and THEN the write reports failure. */
const PUBLISH_THEN_THROW: WriteImpl = async (file, content, real) => {
  await real(file, content);
  throw new Error("simulated failure after publish");
};

describe("local-model editing setting (#1123)", () => {
  let dir: string;
  let file: string;

  const onDisk = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const write = (text: string) => fs.writeFileSync(file, text, "utf8");
  /** A new process: all module state forgotten, same directory. */
  const restart = () => {
    __resetLocalModelSettingsForTests(dir);
    primeLocalModelSettings();
  };

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-local-model-settings-"));
    file = path.join(dir, LOCAL_MODEL_SETTINGS_FILE_NAME);
    __resetLocalModelSettingsForTests(dir);
    writeControl.impl = null;
    writeControl.calls = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    writeControl.impl = null;
    __resetLocalModelSettingsForTests();
    vi.restoreAllMocks();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  describe("reads fail toward off", () => {
    it("is off before any prime, and reading touches no file", () => {
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: 0 });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("is off with no file, and a prime creates nothing", () => {
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("is on only for a well-formed file holding the boolean true", () => {
      write(JSON.stringify({ version: 1, editing: true }));
      primeLocalModelSettings();
      expect(localModelEditingState()).toEqual({ enabled: true, offEpoch: 0 });
    });

    it.each([
      ["not JSON", "{broken"],
      ["an empty file", ""],
      ["an array", JSON.stringify([{ editing: true }])],
      ["an array holding true", "[true]"],
      ["the JSON literal true", "true"],
      ["the JSON literal null", "null"],
      ['editing: "true"', JSON.stringify({ version: 1, editing: "true" })],
      ["editing: 1", JSON.stringify({ version: 1, editing: 1 })],
      ["editing: null", JSON.stringify({ version: 1, editing: null })],
      ["editing: false", JSON.stringify({ version: 1, editing: false })],
      ["no editing key", JSON.stringify({ version: 1 })],
      ["editing nested, not top-level", JSON.stringify({ settings: { editing: true } })],
      ["editing only on __proto__", '{"__proto__": {"editing": true}}'],
    ])("%s → off", (_name, text) => {
      write(text);
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("an oversized file (> 4096 bytes) → off, though it says editing: true", () => {
      write(JSON.stringify({ version: 1, editing: true, pad: "x".repeat(4096) }));
      expect(fs.statSync(file).size).toBeGreaterThan(4096);
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("a file of exactly the bound is still read", () => {
      const base = JSON.stringify({ version: 1, editing: true, pad: "" });
      write(JSON.stringify({ version: 1, editing: true, pad: "x".repeat(4096 - base.length) }));
      expect(fs.statSync(file).size).toBe(4096);
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);
    });

    it("a directory at the path → off, and the prime does not throw", () => {
      fs.mkdirSync(file);
      expect(() => primeLocalModelSettings()).not.toThrow();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });
  });

  describe("round-trip through a restart", () => {
    it("on survives; then off survives", async () => {
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(onDisk()).toEqual({ version: 1, editing: true });

      __resetLocalModelSettingsForTests(dir);
      expect(isLocalModelEditingEnabled()).toBe(false); // nothing until the prime
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);

      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(onDisk()).toEqual({ version: 1, editing: false });

      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("writes a version and ends the file with a newline", async () => {
      await setLocalModelEditing(true);
      expect(onDisk().version).toBe(1);
      expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    });

    it("leaves no temp file behind", async () => {
      await setLocalModelEditing(true);
      await setLocalModelEditing(false);
      expect(fs.readdirSync(dir)).toEqual([LOCAL_MODEL_SETTINGS_FILE_NAME]);
    });
  });

  describe("ordering: Off is immediate, On waits for its write, the last request wins", () => {
    it("Off is effective synchronously, before its promise settles, and bumps offEpoch", async () => {
      await setLocalModelEditing(true);
      const before = localModelEditingState();
      expect(before.enabled).toBe(true);

      const pending = setLocalModelEditing(false);
      // No await yet: the disk write has not happened.
      const during = localModelEditingState();
      expect(during.enabled).toBe(false);
      expect(during.offEpoch).toBe(before.offEpoch + 1);
      expect(onDisk().editing).toBe(true);

      expect(await pending).toEqual({ editing: false, persisted: true });
      expect(onDisk().editing).toBe(false);
    });

    it("every Off request bumps offEpoch, even a redundant one; On never does", async () => {
      const e0 = localModelEditingState().offEpoch;
      await setLocalModelEditing(false);
      await setLocalModelEditing(false);
      expect(localModelEditingState().offEpoch).toBe(e0 + 2);
      await setLocalModelEditing(true);
      expect(localModelEditingState().offEpoch).toBe(e0 + 2);
    });

    it("On is not effective until its promise resolves", async () => {
      const pending = setLocalModelEditing(true);
      expect(isLocalModelEditingEnabled()).toBe(false);
      await Promise.resolve();
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(await pending).toEqual({ editing: true, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(true);
    });

    it("On is not effective while its write is still in flight", async () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      failWrites(async (f, content, real) => {
        await gate;
        await real(f, content);
      });
      const pending = setLocalModelEditing(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(isLocalModelEditingEnabled()).toBe(false);
      release();
      expect(await pending).toEqual({ editing: true, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(true);
    });

    it("ON then OFF overlapping ends off, in memory and on disk", async () => {
      const on = setLocalModelEditing(true);
      const off = setLocalModelEditing(false);
      expect(isLocalModelEditingEnabled()).toBe(false);

      const [onResult, offResult] = await Promise.all([on, off]);
      expect(onResult.editing).toBe(false); // the effective value, not the request
      expect(offResult).toEqual({ editing: false, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(onDisk().editing).toBe(false);
      // Both writes ran, in request order.
      expect(
        writeControl.calls.map((c) => (JSON.parse(c) as { editing: boolean }).editing),
      ).toEqual([true, false]);

      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("an Off issued while an On write is held open still wins", async () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      failWrites(async (f, content, real) => {
        if (!held) {
          held = true;
          await gate;
        }
        await real(f, content);
      });
      const on = setLocalModelEditing(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const epoch = localModelEditingState().offEpoch;
      const off = setLocalModelEditing(false);
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: epoch + 1 });
      release();
      await Promise.all([on, off]);
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(onDisk().editing).toBe(false);
    });

    it("OFF then ON overlapping ends on, in memory and on disk", async () => {
      await setLocalModelEditing(true);
      const off = setLocalModelEditing(false);
      const on = setLocalModelEditing(true);
      expect(isLocalModelEditingEnabled()).toBe(false); // off until the On write lands

      const [offResult, onResult] = await Promise.all([off, on]);
      expect(onResult).toEqual({ editing: true, persisted: true });
      expect(offResult.persisted).toBe(true);
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(onDisk().editing).toBe(true);

      restart();
      expect(isLocalModelEditingEnabled()).toBe(true);
    });

    it("ON, OFF, ON overlapping ends on; ON, OFF, ON, OFF ends off", async () => {
      await Promise.all([
        setLocalModelEditing(true),
        setLocalModelEditing(false),
        setLocalModelEditing(true),
      ]);
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(onDisk().editing).toBe(true);

      await Promise.all([
        setLocalModelEditing(true),
        setLocalModelEditing(false),
        setLocalModelEditing(true),
        setLocalModelEditing(false),
      ]);
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(onDisk().editing).toBe(false);
    });
  });

  describe("a failed write converges the disk toward off", () => {
    it("failed OFF → effective off, the file is removed, and that counts as persisted", async () => {
      await setLocalModelEditing(true);
      failWrites(REJECT);

      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.existsSync(file)).toBe(false);

      writeControl.impl = null;
      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("failed ON from off → stays off, not persisted, and no file is left", async () => {
      failWrites(REJECT);
      expect(await setLocalModelEditing(true)).toEqual({ editing: false, persisted: false });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
    });

    it("failed ON whose bytes were published before it threw → no file reading true remains", async () => {
      failWrites(PUBLISH_THEN_THROW);
      expect(await setLocalModelEditing(true)).toEqual({ editing: false, persisted: false });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.existsSync(file)).toBe(false);

      writeControl.impl = null;
      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("failed ON from off over an existing editing:false file → still off after a restart", async () => {
      await setLocalModelEditing(false);
      failWrites(PUBLISH_THEN_THROW);
      expect(await setLocalModelEditing(true)).toEqual({ editing: false, persisted: false });
      writeControl.impl = null;
      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    // `persisted` means "the disk agrees with the effective value". The rewrite
    // failed, but the earlier successful write is still there saying on, so
    // on IS persisted — reporting otherwise would warn about a restart that
    // changes nothing.
    it("failed redundant ON while already on → still on, and still persisted by the earlier write", async () => {
      await setLocalModelEditing(true);
      failWrites(REJECT);
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(true);
      // The earlier successful write is untouched: on is not deleted from under a UI that says on.
      expect(onDisk().editing).toBe(true);
    });

    it("failed OFF published-then-threw → file removed, off after a restart", async () => {
      await setLocalModelEditing(true);
      failWrites(PUBLISH_THEN_THROW);
      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(fs.existsSync(file)).toBe(false);
    });

    it("an ON superseded by a later ON reports the value the server ended on, not 'off'", async () => {
      // Two windows both switch on. The first request's own write lands but it
      // was superseded, so on its own view editing is still off; it must wait
      // for the queue and report what the second request made true.
      const first = setLocalModelEditing(true);
      const second = setLocalModelEditing(true);
      expect(await first).toEqual({ editing: true, persisted: true });
      expect(await second).toEqual({ editing: true, persisted: true });
    });

    it("an ON superseded by a later OFF reports off, and not as a saved On", async () => {
      const on = setLocalModelEditing(true);
      const off = setLocalModelEditing(false);
      expect(await on).toEqual({ editing: false, persisted: false });
      expect(await off).toEqual({ editing: false, persisted: true });
      expect(onDisk().editing).toBe(false);
    });

    it("one failed write does not poison the next request", async () => {
      failWrites(REJECT);
      await setLocalModelEditing(true);
      writeControl.impl = null;
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(onDisk()).toEqual({ version: 1, editing: true });
    });

    it("a failure is logged, and never thrown to the caller", async () => {
      failWrites(REJECT);
      await expect(setLocalModelEditing(true)).resolves.toBeDefined();
      await expect(setLocalModelEditing(false)).resolves.toBeDefined();
      expect(vi.mocked(console.error)).toHaveBeenCalled();
    });
  });

  describe("what a write carries from the existing file", () => {
    it("unknown top-level keys survive, in both directions", async () => {
      write(JSON.stringify({ version: 1, editing: false, later: { nested: [1, 2] }, note: "x" }));
      await setLocalModelEditing(true);
      expect(onDisk()).toEqual({
        version: 1,
        editing: true,
        later: { nested: [1, 2] },
        note: "x",
      });
      await setLocalModelEditing(false);
      expect(onDisk()).toEqual({
        version: 1,
        editing: false,
        later: { nested: [1, 2] },
        note: "x",
      });
    });

    it("version and editing are this build's, whatever the file held", async () => {
      write(JSON.stringify({ version: 99, editing: "yes", later: true }));
      await setLocalModelEditing(true);
      expect(onDisk()).toEqual({ version: 1, editing: true, later: true });
    });

    it("__proto__, constructor and prototype keys are not carried", async () => {
      write(
        '{"version":1,"editing":false,"__proto__":{"editing":true,"polluted":1},' +
          '"constructor":{"x":1},"prototype":{"y":2},"kept":"yes"}',
      );
      await setLocalModelEditing(true);
      const raw = fs.readFileSync(file, "utf8");
      expect(raw).not.toContain("__proto__");
      expect(raw).not.toContain('"constructor"');
      expect(raw).not.toContain('"prototype"');
      expect(raw).not.toContain("polluted");
      const parsed = onDisk();
      expect(Object.keys(parsed).sort()).toEqual(["editing", "kept", "version"]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("an unusable existing file is simply replaced", async () => {
      write("{broken");
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(onDisk()).toEqual({ version: 1, editing: true });

      write(JSON.stringify(["not", "an", "object"]));
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(onDisk()).toEqual({ version: 1, editing: true });
    });

    it("carried keys are dropped rather than push the file past the read bound", async () => {
      // 4000 bytes of padding: readable now, but over the bound once re-indented
      // with the known fields — and an over-bound file would read as off.
      write(JSON.stringify({ editing: false, pad: "x".repeat(4060) }));
      expect(fs.statSync(file).size).toBeLessThanOrEqual(4096);
      await setLocalModelEditing(true);
      expect(onDisk()).toEqual({ version: 1, editing: true });
      restart();
      expect(isLocalModelEditingEnabled()).toBe(true);
    });
  });

  describe("a prime after a request does not overrule it", () => {
    it("an Off stays off though the disk says true", async () => {
      await setLocalModelEditing(false);
      write(JSON.stringify({ version: 1, editing: true }));
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("an Off still in flight stays off through a prime", async () => {
      write(JSON.stringify({ version: 1, editing: true }));
      const pending = setLocalModelEditing(false);
      primeLocalModelSettings(); // the disk still reads true here
      expect(isLocalModelEditingEnabled()).toBe(false);
      await pending;
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it("an On stays on though the disk says false", async () => {
      await setLocalModelEditing(true);
      write(JSON.stringify({ version: 1, editing: false }));
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);
    });

    it("a prime does not move offEpoch", async () => {
      await setLocalModelEditing(false);
      const epoch = localModelEditingState().offEpoch;
      primeLocalModelSettings();
      expect(localModelEditingState().offEpoch).toBe(epoch);
    });
  });
});

describe("onModelsFileChanged (registry change listeners, #1123)", () => {
  let dir: string;

  const file: ModelsFile = {
    schemaVersion: 1,
    models: [
      {
        id: "m-1",
        provider: "local-ollama",
        displayName: "Local",
        modelId: "qwen2.5:14b-instruct",
        endpoint: "http://127.0.0.1:11434",
        enabled: true,
      },
    ],
    defaultModelId: "m-1",
  };

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-models-listeners-"));
    __resetModelRegistryForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    __resetModelRegistryForTests();
    vi.restoreAllMocks();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("fires once per persist and once per prime, after the cache was replaced", async () => {
    const cb = vi.fn();
    onModelsFileChanged(cb);
    expect(cb).not.toHaveBeenCalled(); // subscribing is not a change

    await persistModelsFile(file);
    expect(cb).toHaveBeenCalledTimes(1);
    await persistModelsFile({ ...file, defaultModelId: null });
    expect(cb).toHaveBeenCalledTimes(2);
    await primeModelStoreCache();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("the listener sees the new registry, not the old one", async () => {
    const { getCachedModelsFile } = await import("../../../src/server/models/registry.js");
    const seen: (string | null)[] = [];
    onModelsFileChanged(() => seen.push(getCachedModelsFile().defaultModelId));
    await persistModelsFile(file);
    await persistModelsFile({ ...file, defaultModelId: null });
    expect(seen).toEqual(["m-1", null]);
  });

  it("does not fire for a write that failed", async () => {
    const cb = vi.fn();
    onModelsFileChanged(cb);
    await expect(
      persistModelsFile({ ...file, schemaVersion: 2 } as unknown as ModelsFile),
    ).rejects.toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("a throwing listener does not make persistModelsFile reject, and later listeners still run", async () => {
    const later = vi.fn();
    onModelsFileChanged(() => {
      throw new Error("listener blew up");
    });
    onModelsFileChanged(later);

    await expect(persistModelsFile(file)).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
    await expect(primeModelStoreCache()).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it("unsubscribe stops the calls, for that listener only", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onModelsFileChanged(a);
    onModelsFileChanged(b);

    await persistModelsFile(file);
    offA();
    offA(); // a second call is harmless
    await persistModelsFile({ ...file, defaultModelId: null });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
