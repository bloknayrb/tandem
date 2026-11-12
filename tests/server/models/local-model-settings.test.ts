import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleNotifyStream } from "../../../src/server/mcp/routes/notify-stream.js";
import {
  __flushLocalModelAnnouncedForTests,
  editingOnWasAnnounced,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  EDITING_ON_NOTICE,
  EDITING_ON_NOTICE_KEY,
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
import type { ModelsFile } from "../../../src/shared/models/contract.js";
import type { TandemNotification } from "../../../src/shared/types.js";

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
  /** Every write started, of any file, so a test can wait for all of them. */
  inFlight: [] as Promise<unknown>[],
}));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: (file: string, content: string): Promise<void> => {
      const isSettings = file.endsWith("local-model-settings.json");
      if (isSettings) writeControl.calls.push(content);
      const impl = writeControl.impl as WriteImpl | null;
      const write =
        isSettings && impl
          ? impl(file, content, actual.atomicWriteConfigFile)
          : actual.atomicWriteConfigFile(file, content);
      writeControl.inFlight.push(write.catch(() => undefined));
      return write;
    },
  };
});

function failWrites(impl: WriteImpl): void {
  writeControl.impl = impl;
}

const REJECT: WriteImpl = async () => {
  throw new Error("simulated write failure");
};
/**
 * A write held open until the test lets it go. `entered` resolves when the
 * module has actually called the writer, so a test waits for the write to be
 * in flight instead of sleeping and hoping. Only the FIRST settings write is
 * held; later ones go straight through.
 */
function holdFirstWrite(): { entered: Promise<void>; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered = (): void => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let held = false;
  failWrites(async (f, content, real) => {
    if (!held) {
      held = true;
      markEntered();
      await gate;
    }
    await real(f, content);
  });
  return { entered, release };
}

/**
 * Wait until nothing is being written. The announced-record
 * (`local-model-announced.json`) is written behind the request that caused it,
 * not awaited by it, so a test that lists the directory — and the teardown
 * that deletes it — must wait for those writes too. `restart()` forgets the
 * module's own queue, so the writer double's list is drained as well, until a
 * whole turn of the event loop starts no new write.
 */
async function writesSettled(): Promise<void> {
  await __flushLocalModelAnnouncedForTests();
  let seen = -1;
  while (seen !== writeControl.inFlight.length) {
    seen = writeControl.inFlight.length;
    await Promise.all(writeControl.inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await __flushLocalModelAnnouncedForTests();
  }
}

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
  /** Every notification pushed since the test began, in order. */
  let pushed: TandemNotification[] = [];
  const editingOnNotices = () => pushed.filter((n) => n.dedupKey === EDITING_ON_NOTICE_KEY);
  const replayed = () => getStartupNotices().filter((n) => n.dedupKey === EDITING_ON_NOTICE_KEY);
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
    writeControl.inFlight = [];
    resetNotifications();
    clearStartupNotices();
    pushed = [];
    subscribeNotifications((n) => pushed.push(n));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    writeControl.impl = null;
    // Before the directory goes: a write still in flight would recreate it.
    await writesSettled();
    resetNotifications();
    clearStartupNotices();
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
      // Both carry `version: 1`, so it is the `editing` rule that reads them
      // off and not the version rule added in round 2.
      [
        "editing nested, not top-level",
        JSON.stringify({ version: 1, settings: { editing: true } }),
      ],
      ["editing only on __proto__", '{"version": 1, "__proto__": {"editing": true}}'],
      // Round 2: the version must be exactly this build's.
      ["no version key, editing: true", JSON.stringify({ editing: true })],
      ['version: "1" (a string), editing: true', JSON.stringify({ version: "1", editing: true })],
      [
        "version: 2 (a later build's), editing: true",
        JSON.stringify({ version: 2, editing: true }),
      ],
      ["version: 0, editing: true", JSON.stringify({ version: 0, editing: true })],
      ["version: 1.5, editing: true", JSON.stringify({ version: 1.5, editing: true })],
      ["version: null, editing: true", JSON.stringify({ version: null, editing: true })],
      ["version: true, editing: true", JSON.stringify({ version: true, editing: true })],
      ["version: [1], editing: true", JSON.stringify({ version: [1], editing: true })],
      ["version only on __proto__", '{"__proto__": {"version": 1}, "editing": true}'],
      ["version nested, not top-level", JSON.stringify({ meta: { version: 1 }, editing: true })],
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
      // No window of Tandem's own is listening here, so the On was never
      // recorded as told and the Off had no record to clear: the settings file
      // is the only file, and nothing else.
      await writesSettled();
      const names = fs.readdirSync(dir).sort();
      expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(names).toEqual([LOCAL_MODEL_SETTINGS_FILE_NAME]);
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
      const hold = holdFirstWrite();
      const pending = setLocalModelEditing(true);
      await hold.entered; // the write has been called and is parked
      expect(writeControl.calls).toHaveLength(1);
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
      expect(editingOnNotices(), "nothing is announced before it is true").toEqual([]);
      hold.release();
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
      const hold = holdFirstWrite();
      const on = setLocalModelEditing(true);
      await hold.entered; // the On's write is in flight, not merely queued
      const epoch = localModelEditingState().offEpoch;
      const off = setLocalModelEditing(false);
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: epoch + 1 });
      // The Off's write is queued behind the held On: one write so far.
      expect(writeControl.calls).toHaveLength(1);
      hold.release();
      const [onResult, offResult] = await Promise.all([on, off]);
      expect(onResult).toEqual({ editing: false, persisted: false });
      expect(offResult).toEqual({ editing: false, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(onDisk().editing).toBe(false);
      expect(
        writeControl.calls.map((c) => (JSON.parse(c) as { editing: boolean }).editing),
      ).toEqual([true, false]);
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

    // Round 2 replaced "version and editing are this build's, whatever the file
    // held" (which stamped version 1 over a version 99 file): a LATER build's
    // file is never rewritten by an On — see "a later build's file" below. What
    // is left of the old rule is the file whose version is not a later one.
    it.each([
      ["no version key", { editing: "yes", later: true }],
      ['version: "1" (a string)', { version: "1", editing: "yes", later: true }],
      ["version: 0", { version: 0, editing: "yes", later: true }],
    ])(
      "%s: an On writes this build's version and a boolean, keeping other keys",
      async (_n, held) => {
        write(JSON.stringify(held));
        expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
        expect(onDisk()).toEqual({ version: 1, editing: true, later: true });
        restart();
        expect(isLocalModelEditingEnabled()).toBe(true);
      },
    );

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

  describe("a later build's file (round 2)", () => {
    const V2 = `${JSON.stringify(
      { version: 2, editing: true, mode: "ask-first", future: { nested: [1, 2] } },
      null,
      4,
    )}\n`;
    const V2_OFF = `${JSON.stringify({ version: 2, editing: false, mode: "ask-first" })}\n`;

    it("reads off, though it says editing: true", () => {
      write(V2);
      primeLocalModelSettings();
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: 0 });
    });

    it("Off is written into it: version 2 and its unknown keys are kept, editing is false", async () => {
      write(V2);
      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(onDisk()).toEqual({
        version: 2,
        editing: false,
        mode: "ask-first",
        future: { nested: [1, 2] },
      });
      expect(writeControl.calls).toHaveLength(1);
      restart();
      expect(isLocalModelEditingEnabled()).toBe(false);
    });

    it.each([
      ["holding editing: true", V2],
      ["holding editing: false", V2_OFF],
    ])(
      "On (%s) leaves the file byte-identical, takes effect in memory, and reports not persisted",
      async (_n, bytes) => {
        write(bytes);
        const before = fs.readFileSync(file);

        expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: false });

        expect(localModelEditingState().enabled).toBe(true);
        expect(isLocalModelEditingEnabled()).toBe(true);
        expect(fs.readFileSync(file).equals(before), "byte-identical").toBe(true);
        expect(writeControl.calls, "the writer was never called").toEqual([]);
        // Nothing was created beside the settings file: with no window of
        // Tandem's own listening, the On is not recorded as told either.
        await writesSettled();
        expect(fs.readdirSync(dir).sort()).toEqual([LOCAL_MODEL_SETTINGS_FILE_NAME]);

        // It was for this run of the server only.
        restart();
        expect(isLocalModelEditingEnabled()).toBe(false);
        expect(fs.readFileSync(file).equals(before)).toBe(true);
      },
    );

    it("a second On is the same answer and still writes nothing", async () => {
      write(V2);
      await setLocalModelEditing(true);
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: false });
      expect(fs.readFileSync(file, "utf8")).toBe(V2);
      expect(writeControl.calls).toEqual([]);
    });

    it("On then Off: off at once, and only the Off is written — with the version kept", async () => {
      write(V2);
      await setLocalModelEditing(true);
      const epoch = localModelEditingState().offEpoch;
      const off = setLocalModelEditing(false);
      expect(localModelEditingState()).toEqual({ enabled: false, offEpoch: epoch + 1 });
      expect(await off).toEqual({ editing: false, persisted: true });
      expect(onDisk()).toMatchObject({ version: 2, editing: false, mode: "ask-first" });
      expect(
        writeControl.calls.map((c) => (JSON.parse(c) as { editing: boolean }).editing),
      ).toEqual([false]);
    });

    it("an On overlapped by an Off never takes effect, and the file ends version 2, editing false", async () => {
      write(V2);
      const on = setLocalModelEditing(true);
      const off = setLocalModelEditing(false);
      expect(await on).toEqual({ editing: false, persisted: false });
      expect(await off).toEqual({ editing: false, persisted: true });
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(onDisk()).toMatchObject({ version: 2, editing: false });
    });

    it("a version far ahead is treated the same way", async () => {
      const far = JSON.stringify({ version: 99, editing: "yes", later: true });
      write(far);
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: false });
      expect(fs.readFileSync(file, "utf8")).toBe(far);
      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(onDisk()).toEqual({ version: 99, editing: false, later: true });
    });

    it("an Off whose write fails still removes the file, so no build can read true from it", async () => {
      write(V2);
      failWrites(REJECT);
      expect(await setLocalModelEditing(false)).toEqual({ editing: false, persisted: true });
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe("switching on is announced (#2404, round 2)", () => {
    it("off → on: exactly one notice, pushed live and registered for replay", async () => {
      await setLocalModelEditing(true);

      expect(pushed).toHaveLength(1);
      const [notice] = pushed;
      expect(notice?.message).toBe(EDITING_ON_NOTICE);
      expect(notice?.dedupKey).toBe(EDITING_ON_NOTICE_KEY);
      expect(notice?.severity).toBe("warning");
      expect(typeof notice?.id).toBe("string");
      expect(notice?.id).not.toBe("");

      // The replay list holds the very same notice, once.
      expect(getStartupNotices()).toEqual([notice]);
    });

    it("the wording says what was allowed and where to switch it off", () => {
      expect(EDITING_ON_NOTICE).toMatch(/comment on and suggest changes/);
      expect(EDITING_ON_NOTICE).toMatch(/If you did not switch this on/);
      expect(EDITING_ON_NOTICE).toMatch(/switch it off in Settings → Models/);
    });

    it("is pushed only once editing really is on", async () => {
      resetNotifications();
      const seenEnabled: boolean[] = [];
      subscribeNotifications(() => seenEnabled.push(isLocalModelEditingEnabled()));
      await setLocalModelEditing(true);
      expect(seenEnabled).toEqual([true]);
    });

    it("a redundant On says nothing more", async () => {
      await setLocalModelEditing(true);
      const first = replayed();
      await setLocalModelEditing(true);
      await setLocalModelEditing(true);
      expect(editingOnNotices()).toHaveLength(1);
      expect(replayed()).toEqual(first);
    });

    it("Off pushes nothing and withdraws the replay — synchronously", async () => {
      await setLocalModelEditing(true);
      expect(replayed()).toHaveLength(1);

      const off = setLocalModelEditing(false);
      expect(replayed(), "withdrawn before the write settles").toEqual([]);
      await off;
      expect(pushed).toHaveLength(1); // still only the On's
      expect(getStartupNotices()).toEqual([]);
    });

    it("an Off with nothing to withdraw pushes nothing", async () => {
      await setLocalModelEditing(false);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("on again after an off is a new transition: a second notice, one replay entry", async () => {
      await setLocalModelEditing(true);
      await setLocalModelEditing(false);
      await setLocalModelEditing(true);
      expect(editingOnNotices()).toHaveLength(2);
      expect(editingOnNotices()[1]?.id).not.toBe(editingOnNotices()[0]?.id);
      expect(replayed()).toEqual([editingOnNotices()[1]]);
    });

    it.each([
      ["rejected", REJECT],
      ["published, then threw", PUBLISH_THEN_THROW],
    ])("a failed On (%s) is not announced", async (_n, impl) => {
      failWrites(impl);
      expect((await setLocalModelEditing(true)).editing).toBe(false);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("an On superseded by an Off never took effect and is not announced", async () => {
      const hold = holdFirstWrite();
      const on = setLocalModelEditing(true);
      await hold.entered;
      const off = setLocalModelEditing(false);
      hold.release();
      await Promise.all([on, off]);
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("two overlapping Ons are one transition: one notice", async () => {
      await Promise.all([setLocalModelEditing(true), setLocalModelEditing(true)]);
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(editingOnNotices()).toHaveLength(1);
      expect(replayed()).toHaveLength(1);
    });

    it("ON, OFF, ON overlapping: one notice, for the On that took effect", async () => {
      await Promise.all([
        setLocalModelEditing(true),
        setLocalModelEditing(false),
        setLocalModelEditing(true),
      ]);
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(editingOnNotices()).toHaveLength(1);
      expect(replayed()).toHaveLength(1);
    });

    it("ON, OFF overlapping after being on: nothing pushed, replay withdrawn", async () => {
      await setLocalModelEditing(true);
      pushed = [];
      await Promise.all([setLocalModelEditing(true), setLocalModelEditing(false)]);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    // Round 3: was "a prime that reads true announces nothing". On at start-up
    // is no longer taken as what the user left: unless a browser was told, it
    // is announced then.
    it("a prime that reads true, with no record that a browser was told, announces it once", () => {
      // Tandem's own window is connected, so the announcement counts as told.
      subscribeNotifications(() => {}, { ownWindow: true });
      write(JSON.stringify({ version: 1, editing: true }));
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        type: "general-error",
        severity: "warning",
        message: EDITING_ON_NOTICE,
        dedupKey: EDITING_ON_NOTICE_KEY,
      });
      expect(getStartupNotices()).toEqual(pushed);

      // A second prime in the same run (a browser heard the first) adds nothing.
      primeLocalModelSettings();
      expect(pushed).toHaveLength(1);
    });

    it("a prime that reads true is silent when a browser was already told", () => {
      write(JSON.stringify({ version: 1, editing: true }));
      fs.writeFileSync(
        path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME),
        JSON.stringify({ version: 1, editing: true, answering: null }),
        "utf8",
      );
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it.each([
      ["editing off", JSON.stringify({ version: 1, editing: false })],
      ["no file", null],
      ["a later build's file saying true", JSON.stringify({ version: 2, editing: true })],
    ])("a prime that reads off (%s) announces nothing", (_n, text) => {
      if (text !== null) write(text);
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("a prime after a request announces nothing, though the disk says true and nobody was told", async () => {
      await setLocalModelEditing(false);
      write(JSON.stringify({ version: 1, editing: true }));
      primeLocalModelSettings();
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(pushed).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    // Round 3: was "…is redundant, and silent" with nothing pushed at all. The
    // prime now announces (nobody was told); the On after it still adds nothing.
    it("an On that already was on from the prime is redundant: nothing beyond the prime's one notice", async () => {
      write(JSON.stringify({ version: 1, editing: true }));
      primeLocalModelSettings();
      expect(pushed).toHaveLength(1);
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(pushed).toHaveLength(1);
      expect(replayed()).toEqual(pushed);
    });

    it("an On that takes effect in memory only (a later build's file) is announced too", async () => {
      write(JSON.stringify({ version: 2, editing: false }));
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: false });
      expect(editingOnNotices()).toHaveLength(1);
      expect(replayed()).toHaveLength(1);
    });

    it("leaves other startup notices alone", async () => {
      const { addStartupNotice } = await import("../../../src/server/startup-notices.js");
      const other: TandemNotification = {
        id: "other-1",
        type: "general-error",
        severity: "info",
        message: "something else",
        dedupKey: "something-else",
        timestamp: 1,
      };
      addStartupNotice(other);
      await setLocalModelEditing(true);
      await setLocalModelEditing(false);
      expect(getStartupNotices()).toEqual([other]);
    });
  });

  describe("a switch nobody saw is announced again after a restart (#2404, round 3)", () => {
    const announcedFile = () => path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    const announcedOnDisk = (): unknown => JSON.parse(fs.readFileSync(announcedFile(), "utf8"));
    /** Everything pushed in this "process", whether or not anyone listened. */
    const raised = () => getBuffer().filter((n) => n.dedupKey === EDITING_ON_NOTICE_KEY);
    /**
     * A new server process on the same app-data directory: the notification
     * buffer, its subscribers, the replay list and every module variable are
     * gone; only the files remain. Then the boot-time prime.
     */
    const newProcess = async () => {
      await writesSettled();
      resetNotifications();
      clearStartupNotices();
      __resetLocalModelSettingsForTests(dir);
      primeLocalModelSettings();
    };

    beforeEach(() => {
      // No browser: drop the subscriber the outer beforeEach attached.
      resetNotifications();
    });

    it("(a) switched on with no browser → announced again at the next start → delivered → silent from then on", async () => {
      expect(await setLocalModelEditing(true)).toEqual({ editing: true, persisted: true });
      expect(raised()).toHaveLength(1);
      expect(replayed()).toEqual(raised());
      await writesSettled();
      // Raised, but written to no stream: nothing is recorded as told.
      expect(editingOnWasAnnounced()).toBe(false);
      expect(fs.existsSync(announcedFile())).toBe(false);

      await newProcess();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(raised(), "raised again at the prime").toHaveLength(1);
      const [again] = raised();
      expect(again).toMatchObject({ message: EDITING_ON_NOTICE, severity: "warning" });
      expect(getStartupNotices()).toEqual([again]);
      expect(editingOnWasAnnounced()).toBe(false);

      // Still nobody: a third start says it a third time.
      await newProcess();
      expect(raised()).toHaveLength(1);
      const [third] = raised();
      expect(getStartupNotices()).toEqual([third]);

      // A browser connects and is sent the replay.
      markStartupNoticeDelivered(third);
      expect(editingOnWasAnnounced()).toBe(true);
      await writesSettled();
      expect(announcedOnDisk()).toEqual({ version: 1, editing: true, answering: null });

      await newProcess();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(raised(), "a browser was told: silent").toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("(b) switched on while a browser is connected → the next start is silent", async () => {
      const seen: TandemNotification[] = [];
      subscribeNotifications((n) => seen.push(n), { ownWindow: true });
      await setLocalModelEditing(true);
      expect(seen.map((n) => n.message)).toEqual([EDITING_ON_NOTICE]);
      expect(editingOnWasAnnounced()).toBe(true);

      await newProcess();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(raised()).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
    });

    it("(c) on, never delivered, then off → the next start is off and silent", async () => {
      await setLocalModelEditing(true);
      const [undelivered] = replayed();
      expect(undelivered).toBeDefined();
      await setLocalModelEditing(false);
      expect(getStartupNotices()).toEqual([]);
      // The withdrawn notice can no longer mark anything as told.
      if (undelivered) markStartupNoticeDelivered(undelivered);
      expect(editingOnWasAnnounced()).toBe(false);

      await newProcess();
      expect(isLocalModelEditingEnabled()).toBe(false);
      expect(raised()).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
      expect(fs.existsSync(announcedFile())).toBe(false);
    });

    it("on (told), off, on again with no browser → the second On is announced again at the next start", async () => {
      const stop = subscribeNotifications(() => {}, { ownWindow: true });
      await setLocalModelEditing(true);
      expect(editingOnWasAnnounced()).toBe(true);
      stop(); // the window is closed

      await setLocalModelEditing(false);
      expect(editingOnWasAnnounced(), "Off clears the record").toBe(false);
      await setLocalModelEditing(true);
      expect(editingOnWasAnnounced()).toBe(false);
      await writesSettled();
      expect(announcedOnDisk()).toEqual({ version: 1, editing: false, answering: null });

      await newProcess();
      expect(isLocalModelEditingEnabled()).toBe(true);
      expect(raised()).toHaveLength(1);
      expect(getStartupNotices()).toEqual(raised());
    });

    it("an unreadable announced-record costs one repeated notice, never silence", async () => {
      subscribeNotifications(() => {}, { ownWindow: true });
      await setLocalModelEditing(true);
      await writesSettled();
      expect(announcedOnDisk()).toEqual({ version: 1, editing: true, answering: null });
      fs.writeFileSync(announcedFile(), "{broken", "utf8");

      await newProcess();
      expect(raised()).toHaveLength(1);
    });

    it("the real notify stream: the first browser to connect is sent the notice, and that is what records it", async () => {
      await setLocalModelEditing(true);
      const [raisedNotice] = raised();
      expect(raisedNotice).toBeDefined();
      await writesSettled();
      expect(editingOnWasAnnounced()).toBe(false);

      const app = express();
      app.get("/api/notify-stream", handleNotifyStream);
      const server = await new Promise<http.Server>((resolve, reject) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
        s.once("error", reject);
      });
      let request: http.ClientRequest | null = null;
      try {
        const address = server.address();
        if (typeof address !== "object" || address === null) throw new Error("no address");

        // The first `data:` event of the stream, whole.
        const first = await new Promise<string>((resolve, reject) => {
          request = http.get(
            {
              host: "127.0.0.1",
              port: address.port,
              path: "/api/notify-stream",
              // What a browser sends for the page Tandem itself serves; without
              // it the stream still gets the notice but does not count as
              // Tandem's own window (see the attack test below).
              headers: { "Sec-Fetch-Site": "same-origin" },
            },
            (res) => {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                text += chunk;
                const event = /^data: (.*)\n\n/m.exec(text);
                if (event?.[1] !== undefined) resolve(event[1]);
              });
              res.on("error", reject);
              res.on("end", () => reject(new Error(`stream ended early: ${text}`)));
            },
          );
          request.on("error", reject);
        });

        expect(JSON.parse(first)).toEqual(raisedNotice);
        expect((JSON.parse(first) as TandemNotification).message).toBe(EDITING_ON_NOTICE);
        // Written to a stream, so now — and only now — it counts as told.
        expect(editingOnWasAnnounced()).toBe(true);
        await writesSettled();
        expect(announcedOnDisk()).toEqual({ version: 1, editing: true, answering: null });
      } finally {
        (request as http.ClientRequest | null)?.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // And so the next start is silent.
      await newProcess();
      expect(raised()).toEqual([]);
      expect(getStartupNotices()).toEqual([]);
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
