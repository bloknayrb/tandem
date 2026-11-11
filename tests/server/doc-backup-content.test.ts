/**
 * Direct tests for `writeDocBackupContent` (#2400) — the content-taking entry
 * into a document's backups list. It is otherwise reached only through
 * short-name adoption, whose tests replace it, so each property its docblock
 * states is pinned here: it ignores (and does not set) the once-per-run gate,
 * applies no size cap, has its own identical-content rule, writes owner-only
 * with an exclusive create, and answers "failed" rather than throwing.
 *
 * Outcomes are pinned, not the fs call that produces them: the write may be
 * `writeFile(…, { flag: "wx" })` or `open("wx")` + write + sync + close.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Notifications buffer + SSE fan-out are irrelevant here (the size-cap skip of
// the ordinary path raises one).
vi.mock(import("../../src/server/notifications.js"), () => ({
  pushNotification: vi.fn(),
}));
// Real `randomUUID` unless a test pins it: the exclusive-create test needs to
// know the snapshot name before the write, and the name ends in a uuid8.
vi.mock(import("node:crypto"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

import { randomUUID } from "node:crypto";

import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  _resetDocBackupGateForTests,
  docBackupsRoot,
  MAX_DOC_BACKUP_BYTES,
  MAX_DOC_BACKUPS,
  snapshotBeforeFirstWrite,
  snapshotFilename,
  writeDocBackupContent,
} from "../../src/server/file-io/doc-backup.js";

const randomUUIDMock = vi.mocked(randomUUID);

describe("writeDocBackupContent", () => {
  let root: string;
  let appDataDir: string;
  let docPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-doc-backup-content-"));
    appDataDir = join(root, "app-data");
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    docPath = join(root, "docs", "thesis.md");
    _resetDocBackupGateForTests();
    // The module logs every snapshot and every failure to stderr.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The per-path subdir `filePath`'s snapshots live in. */
  function subdirOf(filePath: string): string {
    return join(docBackupsRoot(appDataDir), docHash(filePath));
  }

  /** Snapshot files for `filePath` (everything but `source.txt`), name-sorted. */
  function snapshots(filePath: string = docPath): Array<{ name: string; content: string }> {
    const dir = subdirOf(filePath);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n !== "source.txt")
      .sort()
      .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
  }

  /**
   * Plant a snapshot under an explicit, long-past name. Name order is what the
   * module calls "newest", and names written in the same second tie on a random
   * uuid8 — so the identical-content tests fix the order by hand. Anything the
   * module writes afterwards carries today's date and sorts after these.
   */
  function plant(name: string, content: string): string {
    const dir = subdirOf(docPath);
    mkdirSync(dir, { recursive: true });
    const full = join(dir, name);
    writeFileSync(full, content);
    return full;
  }
  const OLDER_NAME = "thesis-20200101-000000-aaaaaaaa.md";
  const NEWEST_NAME = "thesis-20200102-000000-bbbbbbbb.md";

  describe("the once-per-run gate", () => {
    it("still writes after the ordinary pre-overwrite backup has gated the path", async () => {
      writeFileSync(docPath, "bytes on disk\n");
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("written");
      // The gate is set: the ordinary path now refuses this file for the run.
      writeFileSync(docPath, "tandem output\n");
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe(
        "skipped-already-this-run",
      );
      expect(snapshots()).toHaveLength(1);

      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );

      expect(snapshots().map((s) => s.content)).toContain("session text\n");
      expect(snapshots()).toHaveLength(2);
    });

    it("writes both of two calls with different content", async () => {
      expect(await writeDocBackupContent(docPath, "first\n", { appDataDir })).toBe("written");
      expect(await writeDocBackupContent(docPath, "second\n", { appDataDir })).toBe("written");

      expect(
        snapshots()
          .map((s) => s.content)
          .sort(),
      ).toEqual(["first\n", "second\n"]);
    });

    it("does not set the gate: the ordinary backup still snapshots the path afterwards", async () => {
      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );
      writeFileSync(docPath, "bytes on disk\n");

      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("written");
      expect(snapshots().map((s) => s.content)).toContain("bytes on disk\n");
    });
  });

  describe("the size cap", () => {
    it("writes in full when the backups tree is already over the ordinary path's cap", async () => {
      // Make the tree read as over MAX_DOC_BACKUP_BYTES without a 500 MB file:
      // one planted file whose reported size is the whole cap.
      const fillerDir = join(docBackupsRoot(appDataDir), "0".repeat(16));
      mkdirSync(fillerDir, { recursive: true });
      const filler = join(fillerDir, "filler.bin");
      writeFileSync(filler, "x");
      const realStat = fsp.stat.bind(fsp);
      vi.spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
        const st = await realStat(...args);
        if (st && String(args[0]) === filler) st.size = MAX_DOC_BACKUP_BYTES;
        return st;
      }) as typeof fsp.stat);

      // The cap really is in force: the ordinary path refuses a different file.
      const otherDoc = join(root, "docs", "other.md");
      writeFileSync(otherDoc, "other bytes\n");
      expect(await snapshotBeforeFirstWrite(otherDoc, { appDataDir })).toBe("skipped-size-cap");
      expect(snapshots(otherDoc)).toHaveLength(0);

      const content = `${"session line\n".repeat(8192)}end`;
      expect(await writeDocBackupContent(docPath, content, { appDataDir })).toBe("written");

      const snaps = snapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].content.length).toBe(content.length);
      expect(snaps[0].content).toBe(content);
    });
  });

  describe("the identical-content rule", () => {
    it("default: content identical to the newest snapshot adds no file and refreshes its age", async () => {
      plant(OLDER_NAME, "older\n");
      const newest = plant(NEWEST_NAME, "newest\n");
      const longAgo = new Date("2020-01-02T00:00:00Z");
      utimesSync(newest, longAgo, longAgo);

      expect(await writeDocBackupContent(docPath, "newest\n", { appDataDir })).toBe("written");

      expect(snapshots().map((s) => s.name)).toEqual([OLDER_NAME, NEWEST_NAME]);
      // The 30-day sweep counts from now, not from when the snapshot was taken.
      expect(statSync(newest).mtimeMs).toBeGreaterThan(Date.now() - 5 * 60_000);
    });

    it("default: content identical only to an OLDER snapshot adds a new file", async () => {
      plant(OLDER_NAME, "older\n");
      plant(NEWEST_NAME, "newest\n");

      expect(await writeDocBackupContent(docPath, "older\n", { appDataDir })).toBe("written");

      const snaps = snapshots();
      expect(snaps).toHaveLength(3);
      // The fresh copy is the name-newest one, so it is the last to be pruned.
      expect(snaps.map((s) => s.name).slice(0, 2)).toEqual([OLDER_NAME, NEWEST_NAME]);
      expect(snaps[2].content).toBe("older\n");
    });

    it("acceptAnyIdentical: content identical to any snapshot adds no file", async () => {
      plant(OLDER_NAME, "older\n");
      plant(NEWEST_NAME, "newest\n");

      for (const content of ["older\n", "newest\n"]) {
        expect(
          await writeDocBackupContent(docPath, content, { appDataDir, acceptAnyIdentical: true }),
        ).toBe("written");
        expect(snapshots().map((s) => s.name)).toEqual([OLDER_NAME, NEWEST_NAME]);
      }
    });

    it("acceptAnyIdentical: content in no snapshot is still written", async () => {
      plant(OLDER_NAME, "older\n");
      plant(NEWEST_NAME, "newest\n");

      expect(
        await writeDocBackupContent(docPath, "new text\n", {
          appDataDir,
          acceptAnyIdentical: true,
        }),
      ).toBe("written");

      const snaps = snapshots();
      expect(snaps).toHaveLength(3);
      expect(snaps[2].content).toBe("new text\n");
    });

    it("prunes to MAX_DOC_BACKUPS, keeping the copy it just wrote", async () => {
      plant(OLDER_NAME, "older\n");
      plant(NEWEST_NAME, "newest\n");
      plant("thesis-20200103-000000-cccccccc.md", "third\n");

      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );

      const snaps = snapshots();
      expect(snaps).toHaveLength(MAX_DOC_BACKUPS);
      expect(snaps.map((s) => s.name)).not.toContain(OLDER_NAME);
      expect(snaps.map((s) => s.content)).toContain("session text\n");
    });
  });

  describe("how the snapshot file is created", () => {
    it("writes the snapshot owner-only (0o600 on POSIX)", async () => {
      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );

      const snaps = snapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].content).toBe("session text\n");
      // Windows has no mode bits; the backup root's DACL covers the file there.
      if (process.platform !== "win32") {
        expect(statSync(join(subdirOf(docPath), snaps[0].name)).mode & 0o777).toBe(0o600);
      }
    });

    it("creates exclusively: a name that already exists is never written through", async () => {
      // Freeze the two variable parts of the name (second-granular timestamp,
      // uuid8) so the file the write is about to create can be put there first.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date());
      randomUUIDMock.mockReturnValue("deadbeef-0000-4000-8000-000000000000");
      try {
        const collidingName = snapshotFilename(docPath);
        plant(collidingName, "already here\n");

        const outcome = await writeDocBackupContent(docPath, "session text\n", { appDataDir });

        // Not "written", and the content went nowhere: an overwriting open
        // would have answered "written" with the content under that name.
        expect(outcome).toBe("failed");
        expect(snapshots().map((s) => s.content)).not.toContain("session text\n");
      } finally {
        randomUUIDMock.mockReset();
        randomUUIDMock.mockImplementation(
          (await vi.importActual<typeof import("node:crypto")>("node:crypto")).randomUUID,
        );
      }
    });

    it("flushes the snapshot to disk before answering written", async () => {
      // Every promise-API route to a flush (`handle.sync()`, `handle.datasync()`,
      // `writeFile(…, { flush: true })`) goes through the FileHandle prototype.
      const probePath = join(root, "probe.txt");
      writeFileSync(probePath, "probe");
      const probe = await fsp.open(probePath, "r");
      const fileHandleProto = Object.getPrototypeOf(probe) as typeof probe;
      await probe.close();
      const sync = vi.spyOn(fileHandleProto, "sync");
      const datasync = vi.spyOn(fileHandleProto, "datasync");

      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );

      expect(sync.mock.calls.length + datasync.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(snapshots().map((s) => s.content)).toEqual(["session text\n"]);
    });
  });

  describe("failure", () => {
    it('answers "failed" without throwing when the backup directory cannot be created', async () => {
      const notADirectory = join(root, "regular-file");
      writeFileSync(notADirectory, "x");

      await expect(
        writeDocBackupContent(docPath, "session text\n", {
          appDataDir: join(notADirectory, "app-data"),
        }),
      ).resolves.toBe("failed");
      expect(readFileSync(notADirectory, "utf8")).toBe("x");
    });

    it("a failure leaves the path writable on the next attempt", async () => {
      const notADirectory = join(root, "regular-file");
      writeFileSync(notADirectory, "x");
      expect(
        await writeDocBackupContent(docPath, "session text\n", {
          appDataDir: join(notADirectory, "app-data"),
        }),
      ).toBe("failed");

      expect(await writeDocBackupContent(docPath, "session text\n", { appDataDir })).toBe(
        "written",
      );
      expect(snapshots().map((s) => s.content)).toEqual(["session text\n"]);
    });
  });
});
