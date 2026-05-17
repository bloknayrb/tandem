/**
 * Regression test for #696: the docx FormatAdapter's `load()` must surface
 * comment-extraction failures as a user-visible notification rather than
 * silently swallowing them.
 *
 * The production .docx open path goes through `populateDocFromContent` →
 * `prepareContent` in `mcp/file-opener.ts`, which has its own notification.
 * This test exercises the parallel adapter path — `getAdapter("docx").load()`
 * — that any future caller might reach. ADR-036 replaces this with a
 * `LoadResult.partial` containing a `LoadIssue`.
 *
 * We feed `extractDocxComments` a buffer that is not a valid .docx archive
 * so it rejects naturally. We also mock `loadDocx` and `htmlToYDoc` to keep
 * the body-load half of the adapter side-effect-free.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../../src/server/file-io/docx.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadDocx: vi.fn().mockResolvedValue("<p>Body</p>"),
    htmlToYDoc: vi.fn(),
  };
});

import { getAdapter } from "../../src/server/file-io/index.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";

beforeEach(() => {
  resetNotifications();
});

describe("docx adapter — comment-extraction failures (#696)", () => {
  it("pushes a warning notification when extractDocxComments rejects", async () => {
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();

    // Buffer.from("not-a-docx") fails the zip-archive parse in mammoth, so
    // extractDocxComments rejects. Pre-#696 this would be silently swallowed.
    await adapter.load(doc, Buffer.from("not-a-docx"));

    const notifs = getBuffer().filter((n) => n.dedupKey === "docx-comments:format-adapter");
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe("annotation-error");
    expect(notifs[0].severity).toBe("warning");
    expect(notifs[0].message).toContain("Word comments");
  });

  it("still resolves load() when comment extraction fails (comments are non-fatal)", async () => {
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();

    await expect(adapter.load(doc, Buffer.from("not-a-docx"))).resolves.toBeUndefined();
  });

  it("logs the underlying error via console.error for diagnostics", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const adapter = getAdapter("docx");
    await adapter.load(new Y.Doc(), Buffer.from("not-a-docx"));

    const docxCommentLogs = errSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("[docx-comments] Comment extraction failed"),
    );
    expect(docxCommentLogs.length).toBeGreaterThanOrEqual(1);

    errSpy.mockRestore();
  });
});
