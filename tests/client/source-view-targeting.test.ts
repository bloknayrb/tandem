import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import SourceView from "../../src/client/editor/SourceView.svelte";

interface SourceCommands {
  documentId: string;
  save(intent: "save" | "save-as"): Promise<void>;
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
  it("keeps the mounted document ID through an async commit and save", async () => {
    let commands: SourceCommands | null = null;
    const onDraftChange = vi.fn();
    const onSave = vi.fn(async () => {});
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
    await savePromise;
    expect(textarea.readOnly).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(onSave).toHaveBeenCalledWith("doc-a", "save");
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
        onSave: vi.fn(async () => {}),
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
