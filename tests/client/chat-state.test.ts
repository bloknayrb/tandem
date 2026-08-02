// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import ChatStateHarness from "./fixtures/ChatStateHarness.svelte";
import {
  Y_MAP_CHAT,
  Y_MAP_CHAT_DOCUMENT_NAMES,
  Y_MAP_CHAT_SEEN,
  Y_MAP_CHAT_SEEN_INITIALIZED,
} from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";

function claude(id: string, timestamp: number): ChatMessage {
  return { id, timestamp, author: "claude", text: id, read: true };
}

describe("App-owned chat unread state", () => {
  afterEach(() => cleanup());
  it("baselines existing history only after initial CTRL sync, then acknowledges visible replies", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("old", claude("old", 1));
    const view = render(ChatStateHarness, { props: { doc, synced: false, visible: false } });

    expect(view.getByTestId("unread").textContent).toBe("0");
    await view.rerender({
      doc,
      synced: true,
      visible: false,
      initialClaudeIds: ["old"],
    });
    await waitFor(() => {
      expect(doc.getMap(Y_MAP_CHAT_SEEN).get(Y_MAP_CHAT_SEEN_INITIALIZED)).toBe(true);
      expect(view.getByTestId("unread").textContent).toBe("0");
    });

    doc.getMap(Y_MAP_CHAT).set("new", claude("new", 2));
    await waitFor(() => expect(view.getByTestId("unread").textContent).toBe("1"));
    await view.rerender({ doc, synced: true, visible: true });
    await waitFor(() => {
      expect(view.getByTestId("unread").textContent).toBe("0");
      expect(doc.getMap(Y_MAP_CHAT_SEEN).get("new")).toBe(true);
    });
  });

  it("does not baseline a reply injected after the provider sync snapshot", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("history", claude("history", 1));
    // Models the exact race: provider captured [history], then a reply arrived
    // before Svelte scheduled the chat-state initial-sync effect.
    doc.getMap(Y_MAP_CHAT).set("after-boundary", claude("after-boundary", 2));
    const view = render(ChatStateHarness, {
      props: {
        doc,
        synced: true,
        visible: false,
        initialClaudeIds: ["history"],
      },
    });
    await waitFor(() => {
      expect(view.getByTestId("unread").textContent).toBe("1");
      expect(doc.getMap(Y_MAP_CHAT_SEEN).get("history")).toBe(true);
      expect(doc.getMap(Y_MAP_CHAT_SEEN).get("after-boundary")).toBeUndefined();
    });
  });

  it("shares acknowledgements across windows through the CTRL seen map", async () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const forward = (update: Uint8Array) => Y.applyUpdate(second, update);
    const backward = (update: Uint8Array) => Y.applyUpdate(first, update);
    first.on("update", forward);
    second.on("update", backward);
    first.getMap(Y_MAP_CHAT_SEEN).set(Y_MAP_CHAT_SEEN_INITIALIZED, true);
    first.getMap(Y_MAP_CHAT).set("reply", claude("reply", 2));

    const hidden = render(ChatStateHarness, {
      props: { doc: first, synced: true, visible: false },
    });
    const visible = render(ChatStateHarness, {
      props: { doc: second, synced: true, visible: true },
    });
    await waitFor(() => {
      expect(visible.container.querySelector('[data-testid="unread"]')?.textContent).toBe("0");
      expect(hidden.container.querySelector('[data-testid="unread"]')?.textContent).toBe("0");
    });
    first.off("update", forward);
    second.off("update", backward);
  });

  it("never records filenames for open documents that chat does not reference", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT_SEEN).set(Y_MAP_CHAT_SEEN_INITIALIZED, true);
    doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).set("stale-doc", "Stale.md");
    const view = render(ChatStateHarness, {
      props: {
        doc,
        synced: true,
        visible: false,
        openDocuments: [{ id: "unrelated-doc", fileName: "C:\\private\\Unrelated.md" }],
      },
    });

    await waitFor(() => {
      expect(view.getByTestId("document-names").textContent).toBe("[]");
      expect(doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).size).toBe(0);
    });
  });

  it("persists path-free filenames for closed referenced documents across a CTRL restart", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT_SEEN).set(Y_MAP_CHAT_SEEN_INITIALIZED, true);
    doc.getMap(Y_MAP_CHAT).set("about-closed-doc", {
      id: "about-closed-doc",
      timestamp: 1,
      author: "user",
      text: "Remember this document",
      documentId: "closed-doc",
      read: false,
    } satisfies ChatMessage);
    const view = render(ChatStateHarness, {
      props: {
        doc,
        synced: true,
        visible: false,
        openDocuments: [{ id: "closed-doc", fileName: "C:\\private\\Closed notes.md" }],
      },
    });
    await waitFor(() => {
      expect(view.getByTestId("document-names").textContent).toContain("Closed notes.md");
      expect(view.getByTestId("document-names").textContent).not.toContain("private");
    });

    const restarted = new Y.Doc();
    Y.applyUpdate(restarted, Y.encodeStateAsUpdate(doc));
    view.unmount();
    const afterRestart = render(ChatStateHarness, {
      props: { doc: restarted, synced: true, visible: false, openDocuments: [] },
    });
    await waitFor(() => {
      expect(afterRestart.getByTestId("document-names").textContent).toContain("Closed notes.md");
    });
  });
});
