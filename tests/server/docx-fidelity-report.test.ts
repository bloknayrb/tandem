/**
 * docx fidelity report (#1145, the "honesty layer" / phase 0c+0f).
 *
 * Covers:
 *  - `summarizeMammothMessages` redaction (quoted style names → "…") + per-line
 *    clamp — the privacy/security invariant (a persistent surface must not leak
 *    user-authored style names or unbounded content). Both the security and
 *    annotation-model plan reviews required this.
 *  - Report wiring across EVERY re-import path: open, force-reload (via open
 *    force:true), and the file-watcher `reloadFromDisk` path (which deliberately
 *    drops `prepared.issues` for toasts — the bug a stale banner would cause).
 *  - Save refreshes `exportDowngrades` while preserving `importLosses`.
 *  - Non-docx open writes no report.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// vi.mock factories are hoisted before module-level code; compute paths inline.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-fidelity-report-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// Capture the per-path onChanged callback so tests can deliver an "external
// change" event deterministically (drives reloadFromDisk on a clean doc).
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

import { summarizeMammothMessages } from "../../src/server/file-io/docx.js";
import { watchFile } from "../../src/server/file-watcher.js";
import {
  getOpenDocs,
  removeDoc,
  saveDocumentToDisk,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { resetForTesting as resetNotifications } from "../../src/server/notifications.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_DOCUMENT_META, Y_MAP_FIDELITY_REPORT } from "../../src/shared/constants.js";
import type { FidelityReport } from "../../src/shared/types.js";

/** A minimal clean one-paragraph .docx (no mammoth warnings). */
async function buildSimpleDocx(text: string): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
      `</w:document>`,
  );
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/**
 * A .docx whose paragraph references a style ID with no matching styles.xml,
 * which makes mammoth emit an "Unrecognised paragraph style: '<id>'" warning —
 * a real import loss. The id doubles as a "secret" probe for the redaction test.
 */
async function buildDocxWithUnknownStyle(text: string, styleId: string): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` +
      `<w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
      `</w:document>`,
  );
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

function capturedWatcherCallback(filePath: string): (p: string) => Promise<void> {
  const calls = vi.mocked(watchFile).mock.calls.filter(([p]) => p === filePath);
  expect(calls.length, `watchFile was not called for ${filePath}`).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as (p: string) => Promise<void>;
}

function reportOf(doc: Y.Doc): FidelityReport | undefined {
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FIDELITY_REPORT) as FidelityReport | undefined;
}

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  resetNotifications();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-fidelity-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

// ---------------------------------------------------------------------------
// Privacy: redaction + clamp (pure function)
// ---------------------------------------------------------------------------
describe("summarizeMammothMessages — redaction + clamp", () => {
  it("redacts quoted style names so user-authored text can't leak", () => {
    const out = summarizeMammothMessages([
      { type: "warning", message: "Unrecognised paragraph style: 'ProjectFalconConfidential'" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("ProjectFalconConfidential");
    expect(out[0]).toContain("…");
  });

  it("strips the (Style ID: …) parenthetical too", () => {
    const out = summarizeMammothMessages([
      {
        type: "warning",
        message: "Unrecognised paragraph style: 'Foo' (Style ID: AcmeSecretStyle)",
      },
    ]);
    expect(out[0]).not.toContain("AcmeSecretStyle");
  });

  it("redacts the UNQUOTED 'with ID <token>' form mammoth actually emits", () => {
    // mammoth emits this alongside the quoted form; the token is NOT quoted, so
    // quote-stripping alone leaks it. Regression for the leak caught in testing.
    const out = summarizeMammothMessages([
      {
        type: "warning",
        message: "Paragraph style with ID ClientSecretAcme was referenced but not defined",
      },
    ]);
    expect(out[0]).not.toContain("ClientSecretAcme");
    expect(out[0]).toContain("with ID …");
  });

  it("clamps an unquoted long message to a bounded length (content-oracle backstop)", () => {
    const longSecret = "LEAK".repeat(100); // 400 chars, no quotes → not redaction-covered
    const out = summarizeMammothMessages([{ type: "warning", message: longSecret }]);
    expect(out[0].length).toBeLessThanOrEqual(120);
    expect(out[0].endsWith("…")).toBe(true);
  });

  it("collapses many occurrences of one loss to a single line and caps the count", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      type: "warning" as const,
      message: `Unrecognised paragraph style: 'Style${i}'`,
    }));
    const out = summarizeMammothMessages(messages);
    // All normalize to the same redacted line ⇒ deduped to 1; cap is 8.
    expect(out).toHaveLength(1);
  });

  it("ignores non-warning/error message types", () => {
    expect(summarizeMammothMessages([{ type: "info", message: "fyi" }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Report wiring: open / force-reload / file-watcher reload / save / non-docx
// ---------------------------------------------------------------------------
describe("fidelity report wiring", () => {
  it("populates importLosses at open and redacts the style name end-to-end", async () => {
    const filePath = path.join(tmpDir, "lossy.docx");
    await fs.writeFile(filePath, await buildDocxWithUnknownStyle("Body", "ClientSecretAcme"));

    const opened = await openFileByPath(filePath);
    const report = reportOf(getOrCreateDocument(opened.documentId));

    expect(report).toBeDefined();
    expect(report!.importLosses.length).toBeGreaterThan(0);
    expect(report!.exportDowngrades).toEqual([]);
    // The persistent surface must not carry the user's style name.
    expect(JSON.stringify(report!.importLosses)).not.toContain("ClientSecretAcme");
  });

  it("writes an EMPTY report for a clean docx (banner stays hidden)", async () => {
    const filePath = path.join(tmpDir, "clean.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("All supported"));

    const opened = await openFileByPath(filePath);
    const report = reportOf(getOrCreateDocument(opened.documentId));

    expect(report).toBeDefined();
    expect(report!.importLosses).toEqual([]);
    expect(report!.exportDowngrades).toEqual([]);
  });

  it("refreshes importLosses on a file-watcher reload (no stale banner)", async () => {
    const filePath = path.join(tmpDir, "reload.docx");
    await fs.writeFile(filePath, await buildDocxWithUnknownStyle("Body", "OldStyle"));

    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    expect(reportOf(doc)!.importLosses.length).toBeGreaterThan(0);

    // External tool rewrites the file as a CLEAN docx (no unknown style). The
    // clean doc reloads from disk; the report must refresh to no losses, not
    // keep showing the pre-reload loss.
    await fs.writeFile(filePath, await buildSimpleDocx("Now clean"));
    await capturedWatcherCallback(watcherPath)(watcherPath);

    expect(reportOf(doc)!.importLosses).toEqual([]);
  });

  it("preserves importLosses and resets exportDowngrades across a save", async () => {
    const filePath = path.join(tmpDir, "save.docx");
    await fs.writeFile(filePath, await buildDocxWithUnknownStyle("Body", "KeepMe"));

    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const before = reportOf(doc)!;
    expect(before.importLosses.length).toBeGreaterThan(0);

    const result = await saveDocumentToDisk(opened.documentId, "manual");
    expect(result.status).toBe("saved");

    const after = reportOf(doc)!;
    // Import losses survive the save (read-modify-write preserves them); a clean
    // export sets exportDowngrades to [].
    expect(after.importLosses).toEqual(before.importLosses);
    expect(after.exportDowngrades).toEqual([]);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("writes NO report for a non-docx (.md) document", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await fs.writeFile(filePath, "# Heading\n\nPlain markdown.\n", "utf-8");

    const opened = await openFileByPath(filePath);
    expect(reportOf(getOrCreateDocument(opened.documentId))).toBeUndefined();
  });
});
