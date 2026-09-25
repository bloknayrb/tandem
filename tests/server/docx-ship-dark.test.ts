/**
 * `.docx` ships dark (ADR-053): the release-path behaviour.
 *
 * vitest's root `test.env` sets `TANDEM_DOCX=1` so the existing `.docx` suites
 * keep exercising the dark code. A shipped bundle instead carries
 * `__DOCX_ENABLED__ = false`, which `docxEnabled()` resolves identically to "no
 * define, no env" — so every case here stubs the env back to "" to stand in for
 * the release. Each dark-path case has a flag-on or not-applicable twin, so a
 * build that always refused, deleted or hid `.docx` could not pass.
 */

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-docx-dark-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

import type { Request, Response } from "express";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools } from "../../src/server/mcp/awareness.js";
import { registerDiagnosticsTools } from "../../src/server/mcp/diagnostics.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { restoreOpenDocuments } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { registerNavigationTools } from "../../src/server/mcp/navigation.js";
import { handleNotifyStream } from "../../src/server/mcp/routes/notify-stream.js";
import { handleListSessions } from "../../src/server/mcp/routes/sessions.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { sessionKey } from "../../src/server/session/manager.js";
import { clearStartupNotices, getStartupNotices } from "../../src/server/startup-notices.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";

const releaseBuild = () => vi.stubEnv("TANDEM_DOCX", "");

let tmpDir: string;

beforeEach(async () => {
  clearOpenDocs();
  clearStartupNotices();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-docx-dark-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  clearOpenDocs();
  clearStartupNotices();
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const sessionFile = (filePath: string) => path.join(SESSION_DIR, `${sessionKey(filePath)}.json`);

/** Write a session record directly: `.docx` ones are never opened on the dark path. */
async function writeSession(
  name: string,
  opts: { ageMs: number; dirty?: boolean; format?: string },
): Promise<string> {
  const filePath = path.join(tmpDir, name);
  const record = {
    filePath,
    format: opts.format ?? "docx",
    ydocState: "",
    sourceFileMtime: 0,
    lastAccessed: Date.now() - opts.ageMs,
    ...(opts.dirty ? { dirty: true } : {}),
  };
  await fs.writeFile(sessionFile(filePath), JSON.stringify(record), "utf-8");
  return filePath;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const HOUR = 60 * 60 * 1000;

describe("tools/list while .docx ships dark", () => {
  const registrars = [
    registerDocumentTools,
    registerAnnotationTools,
    registerNavigationTools,
    registerAwarenessTools,
    registerApplyTools,
    registerDiagnosticsTools,
  ];

  it("covers every registrar production's createMcpServer calls", () => {
    // A registrar left out here is one whose tool text the wording scan below never reads.
    const serverSrc = readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "server", "mcp", "server.ts"),
      "utf-8",
    );
    const body = serverSrc.slice(serverSrc.indexOf("function createMcpServer("));
    const fnBody = body.slice(0, body.indexOf("\n}\n"));
    const called = [...fnBody.matchAll(/\b(register\w+Tools)\(server/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    expect(called.sort()).toEqual(registrars.map((r) => r.name).sort());
  });

  it("omits the two .docx tools and still offers tandem_restoreBackup", async () => {
    releaseBuild();
    const { client, close } = await setupMcpServer(registrars);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("tandem_restoreBackup");
      expect(names).toContain("tandem_save");
      expect(names).not.toContain("tandem_applyChanges");
      expect(names).not.toContain("tandem_convertToMarkdown");
    } finally {
      await close();
    }
  });

  it("registers them when .docx is enabled", async () => {
    const { client, close } = await setupMcpServer(registrars);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("tandem_applyChanges");
      expect(names).toContain("tandem_convertToMarkdown");
    } finally {
      await close();
    }
  });

  it("no tool, parameter or output-schema text mentions .docx or Word", async () => {
    releaseBuild();
    const { client, close } = await setupMcpServer(registrars);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      const offenders = tools.filter((t) => /docx|\bWord\b/i.test(JSON.stringify(t)));
      expect(offenders.map((t) => t.name)).toEqual([]);
      // tandem_save's .docx-only parameter is gone, not merely reworded.
      const save = tools.find((t) => t.name === "tandem_save");
      expect(Object.keys(save?.inputSchema.properties ?? {})).not.toContain("allowImageLoss");
    } finally {
      await close();
    }
  });

  it("the same scan does find .docx wording when .docx is enabled", async () => {
    const { client, close } = await setupMcpServer(registrars);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => /docx/i.test(JSON.stringify(t)))).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("session restore drops .docx sessions while .docx ships dark", () => {
  it("deletes every .docx session and names only those that would have reopened", async () => {
    releaseBuild();
    const inWindow = await writeSession("current.docx", { ageMs: 0 });
    const dirtyOld = await writeSession("drafted.docx", { ageMs: 2 * HOUR, dirty: true });
    const cleanOld = await writeSession("archived.docx", { ageMs: 2 * HOUR });
    const markdown = await writeSession("notes.md", { ageMs: 2 * HOUR, format: "md" });

    await restoreOpenDocuments(null, { dropDarkDocx: true });

    expect(await exists(sessionFile(inWindow))).toBe(false);
    expect(await exists(sessionFile(dirtyOld))).toBe(false);
    expect(await exists(sessionFile(cleanOld))).toBe(false);
    expect(await exists(sessionFile(markdown))).toBe(true);

    const notices = getStartupNotices();
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice).toMatchObject({
      type: "documents-not-reopened",
      severity: "warning",
      dedupKey: "docx-not-reopened",
    });
    expect(notice.message).toContain("current.docx");
    expect(notice.message).toContain("drafted.docx");
    expect(notice.message).not.toContain("archived.docx");
    expect(notice.message).toContain("2 documents weren't reopened");
    expect(notice.message).toContain("Unsaved edits to them were discarded.");
  });

  it("says nothing about discarded edits when none were unsaved", async () => {
    releaseBuild();
    await writeSession("current.docx", { ageMs: 0 });

    await restoreOpenDocuments(null, { dropDarkDocx: true });

    const [notice] = getStartupNotices();
    expect(notice.message).toContain("1 document wasn't reopened: current.docx.");
    expect(notice.message).not.toContain("discarded");
  });

  it("a second boot has nothing left to name", async () => {
    releaseBuild();
    await writeSession("current.docx", { ageMs: 0 });
    await restoreOpenDocuments(null, { dropDarkDocx: true });
    expect(getStartupNotices()).toHaveLength(1);

    clearStartupNotices();
    await restoreOpenDocuments(null, { dropDarkDocx: true });
    expect(getStartupNotices()).toHaveLength(0);
  });

  it("leaves .docx sessions alone when the caller does not ask for the drop", async () => {
    // stdio starts and read-only stores pass dropDarkDocx: false.
    releaseBuild();
    const old = await writeSession("archived.docx", { ageMs: 2 * HOUR });
    await writeSession("newer.md", { ageMs: 0, format: "md" });

    await restoreOpenDocuments(null, { dropDarkDocx: false });

    expect(await exists(sessionFile(old))).toBe(true);
    expect(getStartupNotices()).toHaveLength(0);
  });

  it("leaves .docx sessions alone when .docx is enabled", async () => {
    // Out of the window, so restore only logs it and never tries to open it.
    const old = await writeSession("archived.docx", { ageMs: 2 * HOUR });
    await writeSession("newer.md", { ageMs: 0, format: "md" });

    await restoreOpenDocuments(null, { dropDarkDocx: true });

    expect(await exists(sessionFile(old))).toBe(true);
    expect(getStartupNotices()).toHaveLength(0);
  });
});

describe("the startup notice reaches every notify-stream subscriber", () => {
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
        .map((w) => JSON.parse(w.slice("data: ".length)) as { dedupKey?: string });
    return { disconnect: () => req.emit("close"), notices };
  }

  it("a tab that connects, a tab that drops, and a later tab each get it once", async () => {
    releaseBuild();
    await writeSession("current.docx", { ageMs: 0 });
    await restoreOpenDocuments(null, { dropDarkDocx: true });

    const first = connect();
    first.disconnect();
    const second = connect();
    try {
      for (const tab of [first, second]) {
        expect(tab.notices()).toHaveLength(1);
        expect(tab.notices()[0].dedupKey).toBe("docx-not-reopened");
      }
    } finally {
      second.disconnect();
    }
  });

  it("a stream gets no startup notice when restore raised none", () => {
    const tab = connect();
    try {
      expect(tab.notices()).toHaveLength(0);
    } finally {
      tab.disconnect();
    }
  });
});

describe("Recent sessions while .docx ships dark", () => {
  async function listed(): Promise<string[]> {
    const json = vi.fn();
    const req = { socket: { remoteAddress: "127.0.0.1" } } as unknown as Request;
    await handleListSessions(req, { json } as unknown as Response);
    const body = json.mock.calls[0][0] as { data: { sessions: Array<{ filePath: string }> } };
    return body.data.sessions.map((s) => path.basename(s.filePath));
  }

  it("omits .docx sessions in a release and lists them when enabled", async () => {
    await writeSession("report.docx", { ageMs: 0 });
    await writeSession("notes.md", { ageMs: 0, format: "md" });

    expect((await listed()).sort()).toEqual(["notes.md", "report.docx"]);
    releaseBuild();
    expect(await listed()).toEqual(["notes.md"]);
  });
});
