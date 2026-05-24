/**
 * Unit tests for the ctrl-meta observer's scratchpad-promote path (#827 review, Low).
 *
 * `notifyDocumentPromoted` is the ONLY thing that surfaces a promoted
 * scratchpad/upload doc to Claude on the channel: promote's `broadcastOpenDocs`
 * uses `withInternal`, which the channel skips, and the doc was added to the
 * observer's private `uploadDocIds` suppression set on open. The promote hook
 * clears that suppression and emits a synthetic `document:opened`.
 *
 * Exercises `makeCtrlMetaObserver` directly (it takes `ctrlDoc` + `pushEvent`
 * deps) so we can drive a controllable `getOpenDocs` mock — the broad
 * event-queue test mocks `getOpenDocs` to an empty Map, which can't represent
 * a tracked upload doc.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { OpenDoc } from "../../src/server/mcp/document-service.js";
import { Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";

// Mutable open-docs map the observer consults to decide upload-suppression.
const openDocsMock = new Map<string, OpenDoc>();
vi.mock("../../src/server/mcp/document-service.js", () => ({
  getOpenDocs: () => openDocsMock,
}));

import {
  makeCtrlMetaObserver,
  notifyDocumentPromoted,
} from "../../src/server/events/observers/ctrl-meta.js";
import type { TandemEvent } from "../../src/server/events/types.js";

let ctrlDoc: Y.Doc;
let events: TandemEvent[];
let dispose: (() => void) | null = null;

beforeEach(() => {
  openDocsMock.clear();
  ctrlDoc = new Y.Doc();
  events = [];
  dispose = makeCtrlMetaObserver({ ctrlDoc, pushEvent: (e) => events.push(e) });
});

afterEach(() => {
  dispose?.();
  dispose = null;
  ctrlDoc.destroy();
});

function makeUploadDoc(id: string): OpenDoc {
  return {
    id,
    filePath: `upload://scratchpad/${id}/Scratchpad.md`,
    format: "md",
    readOnly: false,
    source: "upload",
  };
}

describe("ctrl-meta observer — scratchpad promote", () => {
  it("does NOT emit document:opened when a tracked upload doc opens", () => {
    const docId = "scratch-1";
    openDocsMock.set(docId, makeUploadDoc(docId));

    const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
    meta.set("openDocuments", [{ id: docId, fileName: "Scratchpad.md" }]);

    expect(events.filter((e) => e.type === "document:opened")).toHaveLength(0);
  });

  it("emits exactly one document:opened with the new fileName/format and clears upload suppression on promote", () => {
    const docId = "scratch-2";
    openDocsMock.set(docId, makeUploadDoc(docId));

    // Open as an upload doc — suppressed (tracked in uploadDocIds).
    const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
    meta.set("openDocuments", [{ id: docId, fileName: "Scratchpad.md" }]);
    expect(events.filter((e) => e.type === "document:opened")).toHaveLength(0);

    // Promote to a real file — must surface to Claude.
    notifyDocumentPromoted(docId, { fileName: "Promoted.md", format: "md" });

    const opened = events.filter((e) => e.type === "document:opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].documentId).toBe(docId);
    expect(opened[0].payload).toEqual({ fileName: "Promoted.md", format: "md" });

    // Suppression cleared: a subsequent close now fires (no longer treated as
    // an ephemeral upload). Promote the doc's open-doc record to a real file so
    // the close branch consults a non-upload entry, then remove it.
    openDocsMock.delete(docId);
    meta.set("openDocuments", []);
    const closed = events.filter((e) => e.type === "document:closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].documentId).toBe(docId);
  });

  it("notifyDocumentPromoted is a no-op for an untracked (non-upload) doc", () => {
    notifyDocumentPromoted("never-tracked", { fileName: "X.md", format: "md" });
    expect(events).toHaveLength(0);
  });
});
