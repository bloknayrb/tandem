import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveStore, triggerSave, wireActionDeps } from "../../../src/client/actions/builtin.svelte";

function fetchOk() {
  return Promise.resolve(
    new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function fetchFail() {
  return Promise.resolve(
    new Response(JSON.stringify({ message: "disk full" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("triggerSave / saveStore.lastSaveOk", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    wireActionDeps({
      getActiveTabId: () => "doc-1",
      getActiveDocumentPath: () => "/tmp/doc.md",
      notify,
      openSettings: () => {},
      openSettingsModal: () => {},
      toggleSoloMode: () => {},
      openFindBar: () => {},
      openFindBarTabs: () => {},
      findNext: () => {},
      findPrev: () => {},
      closeActiveTab: () => {},
      openFileDialog: () => {},
      toggleLeftPanel: () => {},
      toggleRightPanel: () => {},
      reopenClosedTab: () => {},
      annotationNext: () => {},
      annotationPrev: () => {},
      annotationAccept: () => {},
      annotationDismiss: () => {},
      selectBlock: () => {},
      toggleAuthorship: () => {},
      toggleFormattingBar: () => {},
      toggleSourceView: () => {},
      saveAs: async () => {},
    });
  });

  it("sets lastSaveOk=true after a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchOk));
    await triggerSave("doc-1");
    expect(saveStore.lastSaveOk).toBe(true);
    expect(saveStore.saving).toBe(false);
    expect(notify).not.toHaveBeenCalledWith("error", expect.anything());
    vi.unstubAllGlobals();
  });

  it("sets lastSaveOk=false and notifies on a failed (non-ok) response", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchFail));
    await triggerSave("doc-1");
    expect(saveStore.lastSaveOk).toBe(false);
    expect(saveStore.saving).toBe(false);
    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("disk full"));
    vi.unstubAllGlobals();
  });

  it("sets lastSaveOk=false and notifies when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    await triggerSave("doc-1");
    expect(saveStore.lastSaveOk).toBe(false);
    expect(saveStore.saving).toBe(false);
    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("try again"));
    vi.unstubAllGlobals();
  });
});
