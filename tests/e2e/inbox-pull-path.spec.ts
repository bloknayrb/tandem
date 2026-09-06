import { expect, type Page, test } from "@playwright/test";
import path from "path";
import type { ToolResponse } from "../../src/shared/types.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openAnnotatePopup,
  selectTextStable,
  submitAnnotation,
} from "./helpers";

/**
 * The pull path, driven end to end (#1783).
 *
 * `tandem_checkInbox` appeared in 0 of 55 E2E specs: every test of the inbox
 * drove `processInboxAnnotations` directly, so nothing proved a comment a real
 * user typed into the popup reaches a real MCP poll — or that Solo withholds it
 * there. Those are the two seams the privacy promise rests on (`hideFromAI`,
 * applied BEFORE the dedup-ledger write).
 *
 * BOUNDED to `checkInbox`'s `userActions` bucket. It says nothing about the
 * reply hold, `tandem_getAnnotations`' filter, the export filter, or the PUSH
 * hold (`isUserPrivacyHeld`, a narrower predicate) — an unearned "all four
 * surfaces" claim is what let the export bypass ship.
 *
 * Every cross-process step is polled. `submitAnnotation` returns on the click
 * while the record still has to travel over Hocuspocus to the server, so a bare
 * first read is a lag-flake and a bare NEGATIVE read is worse: it would pass on
 * a record that simply had not arrived yet.
 */

let mcp: McpTestClient;
let tmpDir: string;

type InboxData = { userActions: Array<{ content?: string }> };
type StatusData = { mode: string };
type AnnotationsData = { annotations: Array<{ content?: string }> };

/**
 * The success payload of an MCP call. `McpTestClient.callTool` throws on an
 * SDK-level error and returns the parsed envelope otherwise, so the narrow here
 * is the same one `cleanupAllOpenDocuments` uses — a server-side `{ error: true }`
 * fails the cast and the test says so, rather than reading `undefined`.
 */
async function callData<T>(name: string): Promise<T> {
  const res = (await mcp.callTool(name)) as ToolResponse<T>;
  if (res.error !== false) throw new Error(`${name} returned an error envelope`);
  return res.data;
}

const mode = async (): Promise<string> => (await callData<StatusData>("tandem_status")).mode;

const inboxContains = async (text: string): Promise<boolean> =>
  (await callData<InboxData>("tandem_checkInbox")).userActions.some((a) => a.content === text);

/** Type a user comment through the real popup, exactly as a user would. */
async function annotate(page: Page, text: string): Promise<void> {
  const editor = page.locator(".tiptap");
  await editor.click();
  await selectTextStable(editor.locator("p").first());
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill(text);
  await submitAnnotation(page, "comment");
}

async function bootWithDocument(page: Page): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tiptap").locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async ({ page }) => {
  // Mode is global for the whole run, so a spec that leaves it on Solo poisons
  // every later one. Restore even when the test failed mid-way, and ASSERT the
  // restore — a silent repair failure is how the next spec inherits Solo.
  const tandemBtn = page.locator("[data-testid='mode-tandem-btn']");
  if ((await tandemBtn.count()) > 0 && (await mode()) !== "tandem") {
    await tandemBtn.click();
    await expect.poll(mode, { timeout: 10_000 }).toBe("tandem");
  }
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

test("a user comment typed in the popup reaches tandem_checkInbox once", async ({ page }) => {
  await bootWithDocument(page);

  // A stated precondition, not a repair: mode is global and three other specs
  // flip it, so if this is not Tandem the run is already wrong and should say so
  // here rather than be quietly clicked back.
  await expect.poll(mode, { timeout: 10_000 }).toBe("tandem");

  // Unique per run. A looser match ("contains 'inbox'") would happily take
  // another spec's leftover comment out of the shared server run.
  const marker = `inbox-e2e-${Date.now()}`;
  await annotate(page, marker);

  await expect
    .poll(() => inboxContains(marker), {
      timeout: 15_000,
      message: "the comment never reached tandem_checkInbox",
    })
    .toBe(true);

  // The dedup ledger: a second poll does not re-surface it. No poll here — the
  // ledger write happened synchronously inside the poll that just succeeded.
  expect(await inboxContains(marker), "checkInbox re-surfaced an already-seen comment").toBe(false);
});

test("Solo holds a user comment on the pull path, and the flip releases it", async ({ page }) => {
  await bootWithDocument(page);
  await expect.poll(mode, { timeout: 10_000 }).toBe("tandem");

  const marker = `inbox-e2e-solo-${Date.now()}`;
  await annotate(page, marker);

  // (a) The positive control, and it must come BEFORE the negative: prove the
  // record arrived at the server. `tandem_getAnnotations` never writes the
  // surfaced ledger (only `processInboxAnnotations` does), so reading it here
  // does not poison the very dedup state the release step depends on.
  await expect
    .poll(
      async () =>
        (await callData<AnnotationsData>("tandem_getAnnotations")).annotations.some(
          (a) => a.content === marker,
        ),
      { timeout: 15_000, message: "the comment never reached the server at all" },
    )
    .toBe(true);

  // (b) Flip to Solo through the real toggle.
  await page.locator("[data-testid='mode-solo-btn']").click();
  await expect.poll(mode, { timeout: 10_000 }).toBe("solo");

  // (c) The hold. Creating in Tandem forgoes the `heldInSolo` stamp, which the
  // "solo" branch of `hideFromAI` ignores anyway — it hides every
  // `author === "user"` record server-authoritatively.
  expect(await inboxContains(marker), "Solo leaked a user comment into checkInbox").toBe(false);

  // (d) The release. Held items stay unsurfaced, so the first Tandem poll after
  // the flip is where they appear — no explicit replay.
  await page.locator("[data-testid='mode-tandem-btn']").click();
  await expect.poll(mode, { timeout: 10_000 }).toBe("tandem");
  await expect
    .poll(() => inboxContains(marker), {
      timeout: 15_000,
      message: "the flip back to Tandem never released the held comment",
    })
    .toBe(true);
});
