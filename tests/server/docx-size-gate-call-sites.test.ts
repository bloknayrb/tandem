/**
 * #1310 — the decompressed-size gate is WIRED, at each of its three call sites.
 *
 * `docx-size-gate.test.ts` proves the gate works when you call it. It cannot prove anybody does.
 * Every one of those tests passes with all three `await assertDocxWithinSizeLimits(...)` lines
 * deleted — including the one in `file-io/index.ts`, which is the entire point of the fix, since it
 * is what stands between mammoth's vendored JSZip and a hostile buffer. A `/simplify` pass that
 * removes a single line would restore the OOM with the module, its docs and its regression guards
 * all still present and all still green.
 *
 * So these tests drive the real entry points and assert refusal. Each one goes red if — and only
 * if — its own call site's line is deleted.
 *
 * The bomb is sized against the SHIPPED ceilings rather than injected limits, because the call
 * sites deliberately do not thread `DocxSizeLimits` (there is no per-caller policy). That is
 * affordable: an honest over-declaration is refused by the declared-size pass without inflating a
 * byte, so the cost here is building the archive, not reading it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above module-level code, so they build their own paths inline.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-gate-sites-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

vi.mock("../../src/server/notifications.js", () => ({ pushNotification: vi.fn() }));

vi.mock("../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { docBackupsRoot } from "../../src/server/file-io/doc-backup.js";
import { applyTrackedChanges } from "../../src/server/file-io/docx-apply.js";
import { DocxTooLargeError, MAX_DOCX_PART_BYTES } from "../../src/server/file-io/docx-size-gate.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { restoreDocumentFromBackup } from "../../src/server/mcp/file-opener.js";
import { resolveAppDataDir } from "../../src/server/platform.js";

/**
 * An archive whose media part declares (honestly) more than the per-part ceiling.
 *
 * Two shape choices are deliberate, both about keeping the NEGATIVE control cheap and legible —
 * a control that OOM-kills the test worker proves the point but reports it as an unrelated crash.
 *
 * 1. The payload is a media part, not `word/document.xml`, so no ungated reader pushes 40 MiB
 *    through htmlparser2 to reach its error.
 * 2. `word/document.xml` is OMITTED entirely, so with the gate removed `applyTrackedChanges` throws
 *    "Missing word/document.xml" at its first read instead of reaching `zip.generateAsync`, which
 *    re-emits every entry — measured, that path exhausts a 4 GB heap and hard-kills the worker.
 *    That crash IS #1310, but as a regression signal a typed rejection is worth more.
 */
let bomb: Buffer;
beforeAll(async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/media/blob.bin", Buffer.alloc(MAX_DOCX_PART_BYTES + 8 * 1024 * 1024, 0x41));
  bomb = (await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })) as Buffer;
  // Sanity: the thing sails through every COMPRESSED-size check in the codebase, which is the
  // premise of #1310. MAX_FILE_SIZE is 50 MB.
  expect(bomb.length).toBeLessThan(1024 * 1024);
}, 60_000);

let tmpDir: string;
beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-gate-sites-"));
});

describe("call site 1 — docxAdapter.parse", () => {
  it("refuses the archive before any reader receives the buffer", async () => {
    // This is the line that guards mammoth. Nothing added to Tandem's own `.async` call sites can
    // reach mammoth's vendored JSZip, so if this call site is dropped there is no second chance.
    await expect(getAdapter("docx").parse(bomb)).rejects.toBeInstanceOf(DocxTooLargeError);
  });
});

describe("call site 2 — applyTrackedChanges", () => {
  it("refuses the archive before loading it", async () => {
    // Re-reads the same untrusted on-disk file the document was opened from, so it carries the
    // identical input; its license gate authenticates nothing about the bytes.
    await expect(
      applyTrackedChanges(bomb, [], { author: "Test", ydocFlatText: "" }),
    ).rejects.toBeInstanceOf(DocxTooLargeError);
  });
});

describe("call site 3 — restoreDocumentFromBackup", () => {
  it("refuses the snapshot BEFORE committing it to disk", async () => {
    // The ordering is the finding, not just the refusal. `reloadFromDisk` would run the gate too —
    // via call site 1 — but only after `atomicWriteBuffer` has already put the rejected archive on
    // disk, and it degrades to a toast rather than a throw. So a gate here that merely refused
    // "eventually" is indistinguishable from no gate here at all: the assertion that separates them
    // is that the ORIGINAL bytes survive on disk.
    const filePath = path.join(tmpDir, "thesis.docx");
    const good = (await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph({ children: [new TextRun("ok")] })] }],
      }),
    )) as Buffer;
    await fs.writeFile(filePath, good);
    const opened = await openFromDisk(filePath);

    // A snapshot predating the gate is an ordinary route to hostile bytes, so plant one directly
    // (the shape `docBackupSnapshotPath` accepts).
    const subdir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(filePath));
    await fs.mkdir(subdir, { recursive: true });
    const name = "thesis-20260101-100000-aaaaaaaa.docx";
    await fs.writeFile(path.join(subdir, name), bomb);
    await fs.writeFile(path.join(subdir, "source.txt"), `${filePath}\n`);

    await expect(restoreDocumentFromBackup(opened.documentId, name)).rejects.toBeInstanceOf(
      DocxTooLargeError,
    );
    expect((await fs.readFile(filePath)).equals(good)).toBe(true);
  });
});
