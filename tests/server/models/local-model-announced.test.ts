import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __flushLocalModelAnnouncedForTests,
  __resetLocalModelAnnouncedForTests,
  announceLocalModelChange,
  answeringWasAnnounced,
  editingOnWasAnnounced,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
  recordEditingOff,
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
import type { TandemNotification } from "../../../src/shared/types.js";

/**
 * `local-model-announced.json` (#2404, round 3): the record of what a browser
 * was ACTUALLY told. Every case runs against a per-test temp dir.
 *
 * A notice counts as told only once it was written to a notify stream: at once
 * when a stream is listening as it is raised, otherwise when a stream that
 * connects later is sent the replay. A notice nobody was sent leaves no record,
 * so the next start announces it again.
 *
 * The write is failed by replacing `atomicWriteConfigFile`, never by file
 * permissions, so the cases mean the same thing on Windows and POSIX. Only a
 * write of this file is diverted.
 */
const writeControl = vi.hoisted(() => ({
  reject: false,
  /** The content of every write of the announced file that was started. */
  calls: [] as string[],
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
      writeControl.calls.push(content);
      if (writeControl.reject) throw new Error("simulated write failure");
      return actual.atomicWriteConfigFile(file, content);
    },
  };
});

const EDITING_KEY = "test-editing-on";
const ANSWERING_KEY = "test-answering-changed";

describe("local-model announced record (#2404)", () => {
  let dir: string;
  let file: string;

  const write = (text: string) => fs.writeFileSync(file, text, "utf8");
  const onDisk = (): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  const flush = () => __flushLocalModelAnnouncedForTests();
  /** A new process on the same directory: nothing remembered but the file. */
  const reload = async () => {
    await flush();
    __resetLocalModelAnnouncedForTests(dir);
  };
  const writtenRecords = () => writeControl.calls.map((c) => JSON.parse(c) as unknown);

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-local-model-announced-"));
    file = path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    __resetLocalModelAnnouncedForTests(dir);
    writeControl.reject = false;
    writeControl.calls = [];
    resetNotifications();
    clearStartupNotices();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    writeControl.reject = false;
    await flush();
    resetNotifications();
    clearStartupNotices();
    __resetLocalModelAnnouncedForTests();
    vi.restoreAllMocks();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  describe("the read fails toward nothing announced", () => {
    it("no file: nothing was announced, and asking creates nothing", () => {
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-1")).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(writeControl.calls).toEqual([]);
    });

    it("a well-formed file is believed: editing told, and exactly that fingerprint", () => {
      write(JSON.stringify({ version: 1, editing: true, answering: "fp-1" }));
      expect(editingOnWasAnnounced()).toBe(true);
      expect(answeringWasAnnounced("fp-1")).toBe(true);
      expect(answeringWasAnnounced("fp-2")).toBe(false);
      expect(answeringWasAnnounced("")).toBe(false);
    });

    it("the two fields are read independently: a bad one does not spoil a good one", () => {
      write(JSON.stringify({ version: 1, editing: true, answering: 5 }));
      expect(editingOnWasAnnounced()).toBe(true);
      expect(answeringWasAnnounced("5")).toBe(false);

      __resetLocalModelAnnouncedForTests(dir);
      write(JSON.stringify({ version: 1, editing: "true", answering: "fp-1" }));
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-1")).toBe(true);
    });

    it.each([
      ["not JSON", "{broken"],
      ["an empty file", ""],
      ["the JSON literal true", "true"],
      ["the JSON literal null", "null"],
      ["an array", JSON.stringify([{ version: 1, editing: true, answering: "fp-1" }])],
      ["no version", JSON.stringify({ editing: true, answering: "fp-1" })],
      ["a later version", JSON.stringify({ version: 2, editing: true, answering: "fp-1" })],
      ["version 0", JSON.stringify({ version: 0, editing: true, answering: "fp-1" })],
      [
        'version "1" (a string)',
        JSON.stringify({ version: "1", editing: true, answering: "fp-1" }),
      ],
      [
        "version only on __proto__",
        '{"__proto__": {"version": 1}, "editing": true, "answering": "fp-1"}',
      ],
      ["wrong types", JSON.stringify({ version: 1, editing: "true", answering: ["fp-1"] })],
      ["editing: 1, answering: null", JSON.stringify({ version: 1, editing: 1, answering: null })],
      [
        "fields nested, not top-level",
        JSON.stringify({ version: 1, record: { editing: true, answering: "fp-1" } }),
      ],
      [
        "fields only on __proto__",
        '{"version": 1, "__proto__": {"editing": true, "answering": "fp-1"}}',
      ],
    ])("%s → nothing announced", (_name, text) => {
      write(text);
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-1")).toBe(false);
    });

    it("an oversized file (> 4096 bytes) → nothing announced, though it says so", () => {
      write(
        JSON.stringify({ version: 1, editing: true, answering: "fp-1", pad: "x".repeat(4096) }),
      );
      expect(fs.statSync(file).size).toBeGreaterThan(4096);
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-1")).toBe(false);
    });

    it("a directory at the path → nothing announced, and nothing thrown", () => {
      fs.mkdirSync(file);
      expect(() => editingOnWasAnnounced()).not.toThrow();
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-1")).toBe(false);
    });
  });

  describe("a notice is recorded only once it was written to a stream", () => {
    it("the notice itself: warning, keyed, with the message given and a fresh id", () => {
      const a = announceLocalModelChange(EDITING_KEY, "first", { editing: true });
      const b = announceLocalModelChange(EDITING_KEY, "second", { editing: true });
      expect(a).toMatchObject({
        type: "general-error",
        severity: "warning",
        message: "first",
        dedupKey: EDITING_KEY,
      });
      expect(typeof a.id).toBe("string");
      expect(a.id).not.toBe("");
      expect(b.id).not.toBe(a.id);
      expect("documentId" in a).toBe(false);
    });

    it("with NO stream listening: pushed and registered for replay, but not recorded", async () => {
      const notice = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });

      expect(getBuffer()).toEqual([notice]);
      expect(getStartupNotices()).toEqual([notice]);
      expect(editingOnWasAnnounced()).toBe(false);

      await reload();
      expect(writeControl.calls, "nothing was written").toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
      expect(editingOnWasAnnounced()).toBe(false);
    });

    it("with a stream listening: recorded at once, and it survives a reload", async () => {
      const seen: TandemNotification[] = [];
      subscribeNotifications((n) => seen.push(n));

      const notice = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(seen).toEqual([notice]);
      // Synchronously: no await between the push and the record.
      expect(editingOnWasAnnounced()).toBe(true);
      // Still registered for a second window that opens later.
      expect(getStartupNotices()).toEqual([notice]);

      await flush();
      expect(onDisk()).toEqual({ version: 1, editing: true, answering: null });
      expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([LOCAL_MODEL_ANNOUNCED_FILE_NAME]);

      await reload();
      expect(editingOnWasAnnounced()).toBe(true);
    });

    it("a stream that stopped listening before the notice does not count", async () => {
      const stop = subscribeNotifications(() => {});
      stop();
      announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(editingOnWasAnnounced()).toBe(false);
      await flush();
      expect(writeControl.calls).toEqual([]);
    });

    it("no stream, then the replay is sent: recorded at that moment, exactly once", async () => {
      const notice = announceLocalModelChange(ANSWERING_KEY, "model set", { answering: "fp-1" });
      await flush();
      expect(answeringWasAnnounced("fp-1")).toBe(false);
      expect(writeControl.calls).toEqual([]);

      markStartupNoticeDelivered(notice);
      expect(answeringWasAnnounced("fp-1")).toBe(true);
      await flush();
      expect(writtenRecords()).toEqual([{ version: 1, editing: false, answering: "fp-1" }]);

      // A second window is sent the same replay: nothing more is written.
      markStartupNoticeDelivered(notice);
      markStartupNoticeDelivered(notice);
      await flush();
      expect(writeControl.calls).toHaveLength(1);
      // The replay itself stays registered for every later window.
      expect(getStartupNotices()).toEqual([notice]);

      await reload();
      expect(answeringWasAnnounced("fp-1")).toBe(true);
      expect(editingOnWasAnnounced()).toBe(false);
    });

    it("delivering some OTHER notice records nothing", async () => {
      announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      markStartupNoticeDelivered({
        id: "other",
        type: "general-error",
        severity: "info",
        message: "something else",
        dedupKey: "something-else",
        timestamp: 1,
      });
      markStartupNoticeDelivered({
        id: "no-key",
        type: "general-error",
        severity: "info",
        message: "no key at all",
        timestamp: 1,
      });
      expect(editingOnWasAnnounced()).toBe(false);
      await flush();
      expect(writeControl.calls).toEqual([]);
    });

    it("a second announcement under the same key replaces the replay, and only the latest is recorded", async () => {
      const first = announceLocalModelChange(ANSWERING_KEY, "set to A", { answering: "fp-a" });
      const second = announceLocalModelChange(ANSWERING_KEY, "set to B", { answering: "fp-b" });

      expect(getBuffer()).toEqual([first, second]); // both were pushed live
      expect(getStartupNotices()).toEqual([second]); // one replay entry: the latest

      markStartupNoticeDelivered(second);
      expect(answeringWasAnnounced("fp-b")).toBe(true);
      expect(answeringWasAnnounced("fp-a")).toBe(false);
      await flush();
      expect(writtenRecords()).toEqual([{ version: 1, editing: false, answering: "fp-b" }]);

      await reload();
      expect(answeringWasAnnounced("fp-b")).toBe(true);
      expect(answeringWasAnnounced("fp-a")).toBe(false);
    });

    it("the two notices are recorded independently, into one file", async () => {
      const editing = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      const answering = announceLocalModelChange(ANSWERING_KEY, "set to A", { answering: "fp-a" });
      expect(getStartupNotices()).toEqual([editing, answering]);

      markStartupNoticeDelivered(answering);
      expect(answeringWasAnnounced("fp-a")).toBe(true);
      expect(editingOnWasAnnounced()).toBe(false);

      markStartupNoticeDelivered(editing);
      expect(editingOnWasAnnounced()).toBe(true);

      await flush();
      // Written in the order they were recorded; the file ends on the last.
      expect(writtenRecords()).toEqual([
        { version: 1, editing: false, answering: "fp-a" },
        { version: 1, editing: true, answering: "fp-a" },
      ]);
      expect(onDisk()).toEqual({ version: 1, editing: true, answering: "fp-a" });
    });

    it("a newer answering model replaces the recorded fingerprint", async () => {
      subscribeNotifications(() => {});
      announceLocalModelChange(ANSWERING_KEY, "set to A", { answering: "fp-a" });
      announceLocalModelChange(ANSWERING_KEY, "set to B", { answering: "fp-b" });
      expect(answeringWasAnnounced("fp-a")).toBe(false);
      expect(answeringWasAnnounced("fp-b")).toBe(true);
      await reload();
      expect(answeringWasAnnounced("fp-b")).toBe(true);
    });
  });

  describe("recordEditingOff", () => {
    it("withdraws the replay and drops the pending delivery: the old notice can no longer record anything", async () => {
      const notice = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(getStartupNotices()).toEqual([notice]);

      recordEditingOff(EDITING_KEY);
      expect(getStartupNotices()).toEqual([]);

      markStartupNoticeDelivered(notice);
      expect(editingOnWasAnnounced()).toBe(false);
      await flush();
      // Nothing was recorded before, so there was nothing to clear either.
      expect(writeControl.calls).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
    });

    it("clears a record that a browser was told, at once, and keeps the answering fingerprint", async () => {
      subscribeNotifications(() => {});
      announceLocalModelChange(ANSWERING_KEY, "set to A", { answering: "fp-a" });
      announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(editingOnWasAnnounced()).toBe(true);

      recordEditingOff(EDITING_KEY);
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-a")).toBe(true);
      expect(getStartupNotices().map((n) => n.dedupKey)).toEqual([ANSWERING_KEY]);

      await flush();
      expect(onDisk()).toEqual({ version: 1, editing: false, answering: "fp-a" });
      await reload();
      expect(editingOnWasAnnounced()).toBe(false);
      expect(answeringWasAnnounced("fp-a")).toBe(true);
    });

    it("clears a record read from disk (told in an earlier run)", async () => {
      write(JSON.stringify({ version: 1, editing: true, answering: null }));
      recordEditingOff(EDITING_KEY);
      expect(editingOnWasAnnounced()).toBe(false);
      await reload();
      expect(editingOnWasAnnounced()).toBe(false);
    });

    it("the next On after it is a new announcement with its own delivery", async () => {
      const first = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      recordEditingOff(EDITING_KEY);
      const second = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(second.id).not.toBe(first.id);
      expect(getStartupNotices()).toEqual([second]);

      markStartupNoticeDelivered(second);
      expect(editingOnWasAnnounced()).toBe(true);
    });
  });

  describe("a failed write", () => {
    it("does not throw, is logged, and leaves the in-memory record updated", async () => {
      writeControl.reject = true;
      subscribeNotifications(() => {});

      expect(() =>
        announceLocalModelChange(EDITING_KEY, "switched on", { editing: true }),
      ).not.toThrow();
      await expect(flush()).resolves.toBeUndefined();

      expect(writeControl.calls).toHaveLength(1);
      expect(editingOnWasAnnounced(), "this run still knows it was told").toBe(true);
      expect(fs.existsSync(file)).toBe(false);
      const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
      expect(logged.some((line) => line.includes(LOCAL_MODEL_ANNOUNCED_FILE_NAME))).toBe(true);

      // The cost: the next start does not know, and announces again.
      await reload();
      expect(editingOnWasAnnounced()).toBe(false);
    });

    it("does not poison the next write", async () => {
      writeControl.reject = true;
      subscribeNotifications(() => {});
      announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      await flush();

      writeControl.reject = false;
      announceLocalModelChange(ANSWERING_KEY, "set to A", { answering: "fp-a" });
      await flush();
      // The later write carries the whole record, the failed part included.
      expect(onDisk()).toEqual({ version: 1, editing: true, answering: "fp-a" });
    });

    it("a failed delivery-time write does not throw into the stream that delivered it", async () => {
      writeControl.reject = true;
      const notice = announceLocalModelChange(EDITING_KEY, "switched on", { editing: true });
      expect(() => markStartupNoticeDelivered(notice)).not.toThrow();
      await flush();
      expect(editingOnWasAnnounced()).toBe(true);
    });
  });
});
