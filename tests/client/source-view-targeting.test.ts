import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import SourceView from "../../src/client/editor/SourceView.svelte";
import { saveExactTarget } from "../../src/client/tabs/target-save";
import SourceViewCommandRegistryHarness from "./fixtures/SourceViewCommandRegistryHarness.svelte";

interface SourceCommands {
  documentId: string;
  save(intent: "save" | "save-as"): Promise<boolean>;
  exit(): Promise<void>;
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourceView exact-document commands", () => {
  it("registers commands once when the parent stores them in reactive state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ markdown: "# Original\n" })),
    );

    const { findByTestId } = render(SourceViewCommandRegistryHarness, {
      props: { documentId: "registered-source", ydoc: new Y.Doc() },
    });

    expect((await findByTestId("source-command-count")).textContent).toBe("1");
  });

  it("waits for a delayed inactive-tab source load before committing its carried draft", async () => {
    let commands: SourceCommands | null = null;
    let resolveRaw!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRaw = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const target = { id: "inactive-source", generation: {} };
    const onSave = vi.fn(async () => true);
    const activateTarget = vi.fn();
    let settled = false;
    const savePromise = saveExactTarget({
      tabId: target.id,
      intent: "save" as const,
      resolveTarget: () => target,
      isSameTarget: (before, after) => before.generation === after.generation,
      isSourceView: () => true,
      activateTarget,
      afterActivate: async () => {
        render(SourceView, {
          props: {
            documentId: target.id,
            ydoc: new Y.Doc(),
            initialDraft: "# Inactive dirty draft\n",
            onDraftChange: vi.fn(),
            onSave,
            onCommandsChange: (_documentId: string, next: SourceCommands | null) => {
              commands = next;
            },
            onExit: vi.fn(),
          },
        });
        await waitFor(() => expect(commands).not.toBeNull());
      },
      getSourceCommands: () => commands,
      saveCommitted: vi.fn(async () => true),
    }).then((result) => {
      settled = true;
      return result;
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(activateTarget).toHaveBeenCalledWith(target.id);
    expect(settled).toBe(false);
    expect(onSave).not.toHaveBeenCalled();

    resolveRaw(jsonResponse({ markdown: "# Original\n" }));
    await expect(savePromise).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const commitRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(commitRequest.body))).toEqual({
      documentId: target.id,
      markdown: "# Inactive dirty draft\n",
    });
    expect(onSave).toHaveBeenCalledWith(target.id, "save", expect.any(Y.Doc));
  });

  it("reports failure instead of saving when source initialization fails", async () => {
    let commands: SourceCommands | null = null;
    const onSave = vi.fn(async () => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    render(SourceView, {
      props: {
        documentId: "failed-source",
        ydoc: new Y.Doc(),
        onDraftChange: vi.fn(),
        onSave,
        onCommandsChange: (_documentId: string, next: SourceCommands | null) => {
          commands = next;
        },
        onExit: vi.fn(),
      },
    });

    await waitFor(() => expect(commands).not.toBeNull());
    await expect(commands!.save("save")).resolves.toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the mounted document ID through an async commit and save", async () => {
    let commands: SourceCommands | null = null;
    const onDraftChange = vi.fn();
    const onSave = vi.fn(async () => true);
    const onExit = vi.fn();
    let resolveCommit!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ markdown: "# Original\n" }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCommit = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { findByTestId } = render(SourceView, {
      props: {
        documentId: "doc-a",
        ydoc: new Y.Doc(),
        onDraftChange,
        onSave,
        onCommandsChange: (documentId: string, next: SourceCommands | null) => {
          expect(documentId).toBe("doc-a");
          commands = next;
        },
        onExit,
      },
    });

    const textarea = (await findByTestId("source-view-textarea")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("Original");
    await fireEvent.input(textarea, { target: { value: "# Edited\n" } });
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const savePromise = commands!.save("save");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(textarea.readOnly).toBe(true);
    expect(textarea.disabled).toBe(false);
    expect(textarea.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(textarea);

    await fireEvent.input(textarea, { target: { value: "# Must be blocked\n" } });
    expect(textarea.value).toBe("# Edited\n");
    expect(onDraftChange).not.toHaveBeenCalledWith(
      "doc-a",
      expect.stringContaining("Must be blocked"),
      expect.anything(),
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      documentId: "doc-a",
      markdown: "# Edited\n",
    });

    resolveCommit(jsonResponse({ success: true }));
    await expect(savePromise).resolves.toBe(true);
    expect(textarea.readOnly).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(onSave).toHaveBeenCalledWith("doc-a", "save", expect.any(Y.Doc));
    expect(onDraftChange).toHaveBeenLastCalledWith("doc-a", "# Edited\n", false);
  });

  it("exposes a commit-aware exit command for palette and toolbar callers", async () => {
    let commands: SourceCommands | null = null;
    const onExit = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ markdown: "# Original\n" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { findByTestId } = render(SourceView, {
      props: {
        documentId: "palette-doc",
        ydoc: new Y.Doc(),
        onDraftChange: vi.fn(),
        onSave: vi.fn(async () => true),
        onCommandsChange: (_documentId: string, next: SourceCommands | null) => {
          commands = next;
        },
        onExit,
      },
    });

    const textarea = (await findByTestId("source-view-textarea")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("Original");
    await fireEvent.input(textarea, { target: { value: "# Palette commit\n" } });
    await commands!.exit();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onExit).toHaveBeenCalledWith("palette-doc");
  });
});
