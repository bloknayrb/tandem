import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

/**
 * #1852 / #1926 — merely OPENING a document and letting a browser attach must
 * not dirty it.
 *
 * #1852 reported that autosave rewrote a review README nobody had edited. That
 * premise cannot be literally true: `autoSaveAllToDisk` skips any document that
 * is not dirty (#851), so the write means the document WAS dirty. The open
 * question is what dirtied it, and the leading hypothesis is the client — a
 * Tiptap schema normalization applied on first sync, which `documents/dirty.ts`
 * counts like any other body-fragment change because it deliberately does not
 * gate on transaction origin.
 *
 * That hypothesis is not answerable from the server: it needs a real browser
 * attaching to a real Y.Doc. Hence an E2E rather than a unit test.
 *
 * The fixture carries the three shapes #1926 measured as the repo-wide
 * round-trip residual, so if any of them is what dirties a document this test
 * is where it surfaces: a hard-wrapped paragraph, a table whose delimiter row
 * is hand-authored tight, and a bold label sitting flush against a fence with
 * no blank line between them.
 */
test.setTimeout(90_000);

const FIXTURE = `# Round-trip residual shapes

This paragraph is hard-wrapped at roughly eighty columns, the way every
document under docs/ is written, so that a serializer which reflowed prose
onto one line would be caught here rather than in a diff nobody reads.

| Code | Trigger |
|---|---|
| \`NO_DOCUMENT\` | Tool called before open. |

**Success:**
\`\`\`json
{ "ok": true }
\`\`\`
`;

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir();
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("opening a document and attaching a browser leaves it clean on disk", async ({ page }) => {
  const file = path.join(tmpDir, "residual-shapes.md");
  fs.writeFileSync(file, FIXTURE, "utf8");

  const open = (await mcp.callTool("tandem_open", { filePath: file })) as {
    data: { documentId: string };
  };
  const docId = open.data.documentId;

  // Attach a real client. This is the step the server-side reasoning cannot
  // stand in for: y-prosemirror syncs Tiptap's view of the document into the
  // Y.XmlFragment, and any normalization it applies is a body change.
  await page.goto("/");
  await expect(page.locator(`[data-testid='tab-${docId}']`)).toBeVisible({ timeout: 20_000 });

  // Past the tab's 500 ms arm window and well past first sync.
  await page.waitForTimeout(3000);

  // The dirty mirror is what the tab renders, and it is the same flag autosave
  // consults — so an absent dot IS the claim "autosave would skip this".
  const dot = page.locator(`[data-testid='unsaved-indicator-${docId}'] .dot`);
  await expect(dot).toHaveCount(0);

  // And the bytes are untouched: no save has been provoked by the attach.
  expect(fs.readFileSync(file, "utf8")).toBe(FIXTURE);
});

/**
 * The same question against the actual document #1852 reported, rather than a
 * fixture built to resemble it. A synthetic file can only show that the shapes
 * I thought to include are harmless; this one is the file whose diff started
 * the issue, so it covers the shapes I did not think of.
 */
test("opening the #1852 review README leaves it clean on disk", async ({ page }) => {
  const source = path.join(process.cwd(), "docs/reviews/2026-09-02-v1-review/README.md");
  const original = fs.readFileSync(source, "utf8");
  const file = path.join(tmpDir, "v1-review-README.md");
  fs.writeFileSync(file, original, "utf8");

  const open = (await mcp.callTool("tandem_open", { filePath: file })) as {
    data: { documentId: string };
  };
  const docId = open.data.documentId;

  await page.goto("/");
  await expect(page.locator(`[data-testid='tab-${docId}']`)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);

  await expect(page.locator(`[data-testid='unsaved-indicator-${docId}'] .dot`)).toHaveCount(0);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
});
