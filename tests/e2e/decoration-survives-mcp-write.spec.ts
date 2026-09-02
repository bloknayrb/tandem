import { expect, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  switchToAnnotationsTab,
} from "./helpers";

/**
 * E2E regression net for #1669 — annotation decorations vanished on every MCP
 * content write.
 *
 * y-prosemirror's `_typeChanged` does not patch the PM doc, it REPLACES it with
 * a single ReplaceStep spanning the whole document. `InlineType.map` maps `from`
 * with assoc +1 and `to` with assoc -1, so every inline decoration collapses to
 * `from >= to` and is dropped. Highlights, comment underlines and suggestion
 * squiggles disappeared the instant Claude wrote anything.
 *
 * The plugin's existing recovery branch could not catch it: it is keyed on
 * OBJECT IDENTITY (`decorationSet === DecorationSet.empty`), and a mapped-empty
 * set is not the singleton, so the gate could not fire until two transactions
 * later. `tandem_edit` never touches the annotations Y.Map, so the observer that
 * would otherwise re-arm recovery never fired either — the user had to type
 * twice to get their own highlights back.
 *
 * WHY E2E AND NOT ONLY A UNIT TEST. The unit specs assert the plugin rebuilds
 * GIVEN a y-sync transaction, and `tests/client/decoration-survives-sync.test.ts`
 * proves a real Y write produces one. Neither watches the DOM. This is the only
 * check that the span the user actually looks at is still painted, through the
 * real server, the real MCP tool and the real editor — the full path the bug
 * report describes.
 *
 * THE ASSERTION IS "NO FURTHER INPUT". The whole character of the bug is that
 * recovery was one transaction away: anything this test does after the MCP call
 * — a click, a keystroke, even a focus — can supply the transaction that hides
 * it. So the wait is on the MCP write landing in the text, and the decoration
 * assertion follows with nothing in between.
 */

let mcp: McpTestClient;
let tmpDir: string;

// "# Test Document" — the heading prefix costs 2 flat chars, so the title text
// spans 2..15. Same constants as `highlight-ux.spec.ts`.
const TITLE_FROM = 2;
const TITLE_TO = 15;
const TITLE_TEXT = "Test Document";

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("#1669: an annotation stays painted through an MCP write to a sibling region", async ({
  page,
}) => {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "Review this title",
    textSnapshot: TITLE_TEXT,
  });

  await page.goto("/");
  await switchToAnnotationsTab(page);

  // `.tandem-editor`, and the locator is scoped to it: since #999 the rail and
  // margin `AnnotationCard` roots carry `data-annotation-id` too, so an
  // unscoped count would stay non-zero with the editor decoration long gone —
  // the exact failure this spec exists to catch.
  const editor = page.locator(".tandem-editor");
  await expect(editor).toContainText(TITLE_TEXT, { timeout: 10_000 });
  const decoration = editor.locator("[data-annotation-id]");
  await expect(decoration).toHaveCount(1, { timeout: 15_000 });

  // Establish that the offsets above still name the title, so a fixture change
  // cannot turn this into a test that annotates the wrong text and then
  // "survives" an edit that never overlapped anything.
  await expect(decoration).toHaveText(TITLE_TEXT);

  // The MCP write. `tandem_appendContent` lands at the END of the document, so
  // it cannot overlap the annotated range by construction — an edit that DID
  // overlap would legitimately invalidate the decoration and this spec would
  // pass on broken code for the wrong reason.
  await mcp.callTool("tandem_appendContent", {
    content: "\n\nAppended by Claude during the regression test.\n",
  });

  await expect(editor).toContainText("Appended by Claude during the regression test.", {
    timeout: 10_000,
  });

  // Still exactly one, still over the same text, with nothing typed in between.
  // Before the fix this was 0 and stayed 0 until the user typed twice.
  await expect(decoration).toHaveCount(1);
  await expect(decoration).toHaveText(TITLE_TEXT);
});
