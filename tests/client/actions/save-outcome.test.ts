import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveStore, triggerSave, wireActionDeps } from "../../../src/client/actions/builtin.svelte";

/** A 200 response carrying a specific SaveResult body. */
function fetchWith(data: Record<string, unknown>) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ data }), {
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

const baseDeps = {
  getActiveTabId: () => "doc-1",
  openSettings: () => {},
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
};

/** Wire the action deps with a document path (the only field that varies). */
const wireDeps = (notify: (...args: unknown[]) => void, path: string): void =>
  wireActionDeps({ ...baseDeps, notify, getActiveDocumentPath: () => path });

describe("triggerSave / saveStore.lastSaveOk", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    wireDeps(notify, "/tmp/doc.md");
  });

  it("sets lastSaveOk=true after a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({})));
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

// ---------------------------------------------------------------------------
// .docx fidelity toasts (#1142 G3) — two facts, at most ONE warning toast
// ---------------------------------------------------------------------------

describe("triggerSave — docx fidelity toasts", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    wireDeps(notify, "/tmp/doc.docx");
  });

  afterEach(() => vi.unstubAllGlobals());

  const warnings = () => notify.mock.calls.filter(([level]) => level === "warning");

  it("says nothing at all on a clean save", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({})));
    await triggerSave("doc-1");
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports export downgrades with a count (that count is real)", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ fidelityWarnings: ["a", "b"] })));
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("2 Word features were simplified");
  });

  it("reports unpreserved imports WITHOUT a number", async () => {
    // unpreservedImports counts capped report LINES, so publishing it as a
    // feature count would be a falsifiable claim on an honesty surface.
    vi.stubGlobal("fetch", vi.fn(fetchWith({ unpreservedImports: 3 })));
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("backed-up original");
    expect(warnings()[0][1]).not.toContain("3");
  });

  it("merges both facts into ONE toast, never a third", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ fidelityWarnings: ["a"], unpreservedImports: 2 })));
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("1 Word feature was simplified");
    expect(warnings()[0][1]).toContain("backed-up original");
  });

  it("agrees the verb with the count (1 was / 2 were)", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ fidelityWarnings: ["a"] })));
    await triggerSave("doc-1");
    expect(warnings()[0][1]).toContain("1 Word feature was simplified");
  });

  it("keeps the integrity error toast distinct and unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ integrityWarnings: ["y"], unpreservedImports: 2 })));
    await triggerSave("doc-1");
    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("backed up"));
    expect(warnings()).toHaveLength(1); // the unpreserved half still speaks
  });
});
