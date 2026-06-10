import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDocBackupGateForTests,
  docBackupsRoot,
  MAX_DOC_BACKUPS,
  sanitizeBackupStem,
  snapshotBeforeFirstWrite,
  snapshotFilename,
  sweepDocBackups,
} from "../../../src/server/file-io/doc-backup.js";

// Notifications buffer + SSE fan-out are irrelevant here; capture calls instead.
vi.mock("../../../src/server/notifications.js", () => ({
  pushNotification: vi.fn(),
}));
// The Windows ACL helper spawns icacls/whoami — not something unit tests should do.
vi.mock("../../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import { pushNotification } from "../../../src/server/notifications.js";

const pushNotificationMock = vi.mocked(pushNotification);

describe("doc-backup", () => {
  let root: string;
  let appDataDir: string;
  let docPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-doc-backup-"));
    appDataDir = join(root, "app-data");
    mkdirSync(appDataDir, { recursive: true });
    docPath = join(root, "docs", "thesis.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    _resetDocBackupGateForTests();
    pushNotificationMock.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** All snapshot files (non-source.txt) across every per-path subdir. */
  function allSnapshots(): Array<{ subdir: string; name: string; content: string }> {
    const backupRoot = docBackupsRoot(appDataDir);
    const out: Array<{ subdir: string; name: string; content: string }> = [];
    let subdirs: string[];
    try {
      subdirs = readdirSync(backupRoot);
    } catch {
      return out;
    }
    for (const sub of subdirs) {
      for (const name of readdirSync(join(backupRoot, sub))) {
        if (name === "source.txt") continue;
        out.push({ subdir: sub, name, content: readFileSync(join(backupRoot, sub, name), "utf8") });
      }
    }
    return out;
  }

  describe("snapshotBeforeFirstWrite", () => {
    it("snapshots the pre-existing on-disk bytes on first write", async () => {
      writeFileSync(docPath, "original content\n");

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("written");
      const snaps = allSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].content).toBe("original content\n");
      expect(snaps[0].name).toMatch(/^thesis-\d{8}-\d{6}-[0-9a-f]{8}\.md$/);
      const sourceTxt = readFileSync(
        join(docBackupsRoot(appDataDir), snaps[0].subdir, "source.txt"),
        "utf8",
      );
      expect(sourceTxt).toBe(`${docPath}\n`);
    });

    it("skips the second save of the same path in the same run", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });
      writeFileSync(docPath, "tandem output\n");

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("skipped-already-this-run");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("skips silently when the file does not exist yet, and gates the path", async () => {
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("skipped-no-source");
      // A later save in the same run only ever overwrites Tandem's own output.
      writeFileSync(docPath, "tandem output\n");
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe(
        "skipped-already-this-run",
      );
      expect(allSnapshots()).toHaveLength(0);
    });

    it("skips when on-disk bytes equal the newest snapshot (restart, no external edit)", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });
      _resetDocBackupGateForTests(); // simulate a new server run

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("skipped-identical");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("writes a new snapshot across runs when content changed, pruning beyond the cap", async () => {
      for (let i = 0; i < MAX_DOC_BACKUPS + 2; i++) {
        writeFileSync(docPath, `version ${i}\n`);
        _resetDocBackupGateForTests();
        // Distinct mtime-second timestamps aren't guaranteed fast in a loop,
        // but the uuid8 suffix keeps names unique; sort ties are fine.
        expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("written");
      }

      const snaps = allSnapshots();
      expect(snaps).toHaveLength(MAX_DOC_BACKUPS);
      // The newest content always survives the prune.
      expect(snaps.map((s) => s.content)).toContain(`version ${MAX_DOC_BACKUPS + 1}\n`);
    });

    it("skips and notifies once when the total-size cap is exceeded", async () => {
      // Cap of 15: the first 10-byte snapshot fits, the second would push the
      // tree to 20 — exercising the exceeded-AFTER-some-writes branch, not
      // just "cap smaller than any single file".
      writeFileSync(docPath, "0123456789");
      const otherPath = join(root, "docs", "other.md");
      writeFileSync(otherPath, "0123456789");

      const first = await snapshotBeforeFirstWrite(docPath, { appDataDir, maxTotalBytes: 15 });
      const second = await snapshotBeforeFirstWrite(otherPath, { appDataDir, maxTotalBytes: 15 });
      const third = await snapshotBeforeFirstWrite(otherPath, { appDataDir, maxTotalBytes: 15 });

      expect(first).toBe("written");
      expect(second).toBe("skipped-size-cap");
      expect(third).toBe("skipped-already-this-run");
      expect(allSnapshots()).toHaveLength(1);
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);
      expect(pushNotificationMock.mock.calls[0][0]).toMatchObject({
        dedupKey: "doc-backup:size-cap",
        severity: "warning",
      });
    });

    it("returns failed (never throws), notifies once, and retries on the next save", async () => {
      writeFileSync(docPath, "original content\n");
      // A FILE at the doc-backups root makes every mkdir of a subdir fail.
      writeFileSync(docBackupsRoot(appDataDir), "not a directory");

      const first = await snapshotBeforeFirstWrite(docPath, { appDataDir, documentId: "doc-1" });
      expect(first).toBe("failed");
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);
      expect(pushNotificationMock.mock.calls[0][0]).toMatchObject({
        documentId: "doc-1",
        severity: "warning",
      });

      // A second failure on the same path retries but does NOT re-notify —
      // the 60s autosave loop would otherwise toast every minute.
      const stillFailing = await snapshotBeforeFirstWrite(docPath, { appDataDir });
      expect(stillFailing).toBe("failed");
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);

      // Clear the obstruction — the gate was NOT set, so the next save retries.
      rmSync(docBackupsRoot(appDataDir));
      const second = await snapshotBeforeFirstWrite(docPath, { appDataDir });
      expect(second).toBe("written");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("snapshots an existing victim file on a Save-As collision path", async () => {
      // Same entry point the save-as call site uses: target exists with
      // content Tandem never produced.
      const victim = join(root, "docs", "existing-notes.md");
      writeFileSync(victim, "the victim's irreplaceable notes\n");

      const outcome = await snapshotBeforeFirstWrite(victim, { appDataDir });

      expect(outcome).toBe("written");
      expect(allSnapshots()[0].content).toBe("the victim's irreplaceable notes\n");
    });
  });

  describe("sanitizeBackupStem", () => {
    it.each([
      { input: "thesis", expected: "thesis", why: "clean names pass through" },
      { input: "CON", expected: "doc-CON", why: "Windows reserved device stem" },
      { input: "con.tar", expected: "doc-con.tar", why: "reserved stem before FIRST dot" },
      { input: "notes ", expected: "notes", why: "Windows strips trailing spaces" },
      { input: "notes..", expected: "notes", why: "Windows strips trailing dots" },
      { input: "a/b\\c", expected: "a_b_c", why: "separators can't escape the subdir" },
      { input: 'we<>:"|?*ird', expected: "we_______ird", why: "Windows-illegal chars" },
      { input: "x".repeat(80), expected: "x".repeat(40), why: "length cap" },
      { input: "", expected: "doc", why: "empty falls back to a generic stem" },
      { input: "...", expected: "doc", why: "dot-only collapses to empty then falls back" },
      { input: "tab\tname", expected: "tab_name", why: "C0 control characters" },
    ])("sanitizes $input ($why)", ({ input, expected }) => {
      expect(sanitizeBackupStem(input)).toBe(expected);
    });
  });

  describe("snapshotFilename", () => {
    it("embeds the sanitized stem, a sortable timestamp, and the extension", () => {
      // Bare basename — a `C:\...` literal would parse as a single basename on
      // POSIX CI and a path on Windows, making the assertion platform-split.
      const name = snapshotFilename("CON.md", new Date(2026, 5, 9, 14, 15, 0));
      expect(name).toMatch(/^doc-CON-20260609-141500-[0-9a-f]{8}\.md$/);
    });
  });

  describe("sweepDocBackups", () => {
    it("removes expired snapshots and empty subdirs, keeps fresh ones and strays", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });

      const freshSub = allSnapshots()[0].subdir;
      const backupRoot = docBackupsRoot(appDataDir);

      // Second subdir holding only an expired snapshot + source.txt.
      const expiredSub = join(backupRoot, "deadbeef");
      mkdirSync(expiredSub, { recursive: true });
      const expired = join(expiredSub, "old-20250101-000000-aabbccdd.md");
      writeFileSync(expired, "ancient\n");
      writeFileSync(join(expiredSub, "source.txt"), "/gone/old.md\n");
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await fs.utimes(expired, old, old);

      // Third subdir holding only a stray non-snapshot file — never touched.
      const straySub = join(backupRoot, "cafebabe");
      mkdirSync(straySub, { recursive: true });
      writeFileSync(join(straySub, "unrelated.bin"), "leave me alone");

      const result = await sweepDocBackups(appDataDir);

      expect(result).toMatchObject({ cleaned: 1, failed: 0 });
      // "deadbeef" (expired) is gone; the fresh subdir and the stray survive.
      expect(readdirSync(backupRoot).sort()).toEqual(["cafebabe", freshSub].sort());
      expect(readdirSync(straySub)).toEqual(["unrelated.bin"]);
    });

    it("is silent and safe when the backup root does not exist", async () => {
      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });
    });
  });
});
