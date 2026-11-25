/**
 * The two error arms the owner fields' publishing added to the registry
 * (#2358 PR 5a-3): a listener told after a broadcast that throws, and a room
 * whose republish write throws. Both log a fixed line and leave the rest of
 * the work done; neither throws to its caller.
 *
 * The provider is mocked so one room's `getOrCreateDocument` can be made to
 * throw; every other room is a real Y.Doc.
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as Y from "yjs";

const docs = new Map<string, Y.Doc>();
let failingRoom: string | undefined;

vi.mock("../../src/server/yjs/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/yjs/provider.js")>();
  return {
    ...actual,
    getOrCreateDocument: (name: string) => {
      if (name === failingRoom) throw new Error("room unavailable");
      let doc = docs.get(name);
      if (doc === undefined) {
        doc = new Y.Doc();
        docs.set(name, doc);
      }
      return doc;
    },
  };
});

const { broadcastOpenDocs, setOpenDocsWrittenListener, writePublishedOpenDocs } = await import(
  "../../src/server/documents/registry.js"
);
const {
  addDoc: registryAddDoc,
  removeDoc,
  resetPublished,
} = await import("../../src/server/documents/registry-testing.js");
const { CTRL_ROOM, Y_MAP_DOCUMENT_META, Y_MAP_OPEN_DOCUMENTS } = await import(
  "../../src/shared/constants.js"
);

let errSpy: MockInstance;

function addDoc(id: string): void {
  registryAddDoc(id, {
    id,
    filePath: `/tmp/${id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  } as Parameters<typeof registryAddDoc>[1]);
}

beforeEach(() => {
  docs.clear();
  failingRoom = undefined;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setOpenDocsWrittenListener(undefined);
  removeDoc("doc-a");
  removeDoc("doc-b");
  resetPublished();
  errSpy.mockRestore();
});

describe("the registry's publishing error arms (#2358 PR 5a-3)", () => {
  it("a listener that throws after a broadcast is logged, and the broadcast still wrote", () => {
    addDoc("doc-a");
    setOpenDocsWrittenListener(() => {
      throw new Error("guard failed");
    });
    expect(() => broadcastOpenDocs()).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      "[Tandem] broadcastOpenDocs: the owner-field guard could not attach:",
      expect.any(Error),
    );
    const list = docs.get(CTRL_ROOM)?.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_OPEN_DOCUMENTS);
    expect(list).toEqual([expect.objectContaining({ id: "doc-a" })]);
  });

  it("a room whose republish write throws is logged and skipped; the other rooms are written", () => {
    addDoc("doc-a");
    addDoc("doc-b");
    broadcastOpenDocs();
    // Make the republish differ from what the broadcast wrote, so a write is due.
    for (const room of [CTRL_ROOM, "doc-a", "doc-b"]) {
      docs.get(room)?.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_OPEN_DOCUMENTS, []);
    }
    failingRoom = "doc-a";
    let written = 0;
    expect(() => {
      written = writePublishedOpenDocs([CTRL_ROOM, "doc-a", "doc-b"]);
    }).not.toThrow();
    expect(written).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      "[Tandem] the owner fields could not be republished to a room:",
      expect.any(Error),
    );
    for (const room of [CTRL_ROOM, "doc-b"]) {
      expect(docs.get(room)?.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_OPEN_DOCUMENTS)).toHaveLength(2);
    }
  });
});
