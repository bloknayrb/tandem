/**
 * #1662 remainder: a document whose `fs.watch` fails during boot-time session
 * restore must still tell the user, and the user is not connected yet.
 *
 * `restoreOpenDocuments` runs before the server binds, so the live push from
 * `notifyNotWatching` reaches no notify stream. These cases drive the real
 * restore → `openFromRestore` → `wireFileWatcher` → `watchFile` path with
 * `fs.watch` refusing, then connect a notify stream AFTERWARDS and assert it is
 * told — the observable the issue's triage asked for.
 */

import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-restore-watch-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

/**
 * `fs.watch` under test control. `file-watcher.ts` does `import fs from
 * "node:fs"` and calls `fs.watch`, so the override has to land on `default` as
 * well as the named export — a named-only override never reaches it. Everything
 * else is the real module, because restore reads sessions and the document
 * from disk. A refusal throws EMFILE (inotify's `max_user_watches`, the
 * commonest Linux failure); otherwise an inert handle, so no real watch leaks.
 */
const watchControl = vi.hoisted(() => ({ refuse: true }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = vi.fn(() => {
    if (watchControl.refuse) {
      throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
    }
    const handle = {
      on: () => handle,
      close: () => {},
    };
    return handle;
  });
  return { ...actual, watch, default: { ...actual, watch } };
});

/** `deleteSession`, rejectable on demand to throw from inside restore. */
const sessionControl = vi.hoisted(() => ({ rejectDelete: false }));
vi.mock(import("../../src/server/session/manager"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/session/manager")>();
  return {
    ...actual,
    deleteSession: async (filePath: string) => {
      if (sessionControl.rejectDelete) throw new Error("injected deleteSession failure");
      return actual.deleteSession(filePath);
    },
  };
});

import type { Request, Response } from "express";
import { unwatchAll, watchFile } from "../../src/server/file-watcher.js";
import { restoreOpenDocuments } from "../../src/server/mcp/document-service.js";
import { handleNotifyStream } from "../../src/server/mcp/routes/notify-stream.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { sessionKey } from "../../src/server/session/manager.js";
import {
  clearStartupNotices,
  getStartupNotices,
  isStartupRestoreInProgress,
} from "../../src/server/startup-notices.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { clearOpenDocs } from "../helpers/doc-service.js";

const mockWatch = fsSync.watch as unknown as ReturnType<typeof vi.fn>;

let tmpDir: string;

beforeEach(async () => {
  clearOpenDocs();
  clearStartupNotices();
  unwatchAll();
  mockWatch.mockClear();
  watchControl.refuse = true;
  sessionControl.rejectDelete = false;
  await fs.mkdir(SESSION_DIR, { recursive: true });
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tandem-restore-watch-")));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  unwatchAll();
  clearOpenDocs();
  clearStartupNotices();
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  // The platform mock repoints TANDEM_APP_DATA_DIR at this file's directory and
  // restore wires real annotation stores and autosave. RESTORE the variable and
  // cancel pending writes through the helper, never by deleting it.
  await teardownFileAppDataDir();
});

/** A real document on disk plus a current session record for it. */
async function writeDocWithSession(name: string, format = "md"): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, "# Restored\n\nSome text.\n", "utf-8");
  const record = {
    filePath,
    format,
    ydocState: "",
    sourceFileMtime: 0,
    lastAccessed: Date.now(),
  };
  await fs.writeFile(
    path.join(SESSION_DIR, `${sessionKey(filePath)}.json`),
    JSON.stringify(record),
    "utf-8",
  );
  return filePath;
}

/** A notify stream connected NOW, with the notices written to it. */
function connect() {
  const req = new EventEmitter();
  const writes: string[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    writableEnded: false,
  };
  handleNotifyStream(req as unknown as Request, res as unknown as Response);
  const notices = () =>
    writes
      .filter((w) => w.startsWith("data: "))
      .map(
        (w) =>
          JSON.parse(w.slice("data: ".length)) as {
            dedupKey?: string;
            severity?: string;
            message?: string;
          },
      );
  return { disconnect: () => req.emit("close"), notices };
}

describe("a boot-time watch failure reaches tabs that connect later (#1662)", () => {
  it("replays the not-watching warning to a stream that connects after restore", async () => {
    const filePath = await writeDocWithSession("restored.md");

    expect(await restoreOpenDocuments(null)).toBe(1);
    // Non-vacuous: the restore really tried to watch and was refused.
    expect(mockWatch).toHaveBeenCalled();
    expect(isStartupRestoreInProgress()).toBe(false);

    const tab = connect();
    try {
      const lost = tab.notices().filter((n) => n.dedupKey === `watch-lost:${filePath}`);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.severity).toBe("warning");
      expect(lost[0]?.message).toContain("restored.md");
    } finally {
      tab.disconnect();
    }
  });

  it("stops replaying once a later watch of that path succeeds", async () => {
    const filePath = await writeDocWithSession("recovers.md");
    await restoreOpenDocuments(null);
    expect(getStartupNotices()).toHaveLength(1);

    watchControl.refuse = false;
    expect(watchFile(filePath, vi.fn().mockResolvedValue(undefined))).toBe(true);

    const tab = connect();
    try {
      expect(tab.notices().filter((n) => n.dedupKey === `watch-lost:${filePath}`)).toEqual([]);
    } finally {
      tab.disconnect();
    }
  });

  it("paired direction: a restore whose watch succeeds leaves nothing to replay", async () => {
    watchControl.refuse = false;
    await writeDocWithSession("healthy.md");

    expect(await restoreOpenDocuments(null)).toBe(1);
    expect(mockWatch).toHaveBeenCalled();
    expect(getStartupNotices()).toHaveLength(0);
  });

  it("a watch failure after restore has finished is not registered for replay", async () => {
    await writeDocWithSession("restored.md");
    await restoreOpenDocuments(null);
    clearStartupNotices();

    const later = path.join(tmpDir, "opened-later.md");
    expect(watchFile(later, vi.fn().mockResolvedValue(undefined))).toBe(false);
    expect(getStartupNotices()).toHaveLength(0);
  });

  it("a restore that throws still closes the window", async () => {
    // `dropDarkDocxSessions` awaits `deleteSession` outside the per-document
    // try/catch, so a rejection there escapes restore. A throwing per-document
    // open would not: that loop swallows it.
    vi.stubEnv("TANDEM_DOCX", "");
    await writeDocWithSession("dark.docx", "docx");
    sessionControl.rejectDelete = true;

    await expect(restoreOpenDocuments(null, { dropDarkDocx: true })).rejects.toThrow(
      "injected deleteSession failure",
    );
    expect(isStartupRestoreInProgress()).toBe(false);

    const later = path.join(tmpDir, "opened-later.md");
    expect(watchFile(later, vi.fn().mockResolvedValue(undefined))).toBe(false);
    expect(getStartupNotices()).toHaveLength(0);
  });
});
