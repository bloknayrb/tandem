// @vitest-environment happy-dom

/**
 * `CodexApprovalModal` is the human-in-the-loop gate on everything Codex writes.
 * Two properties are load-bearing and neither had coverage:
 *
 *   1. It must not poll for users who have no Codex integration. It mounted
 *      unconditionally and hit `/api/codex/approvals` every 750 ms forever.
 *   2. It must show WHAT it is asking permission for. The component declared a
 *      local `Approval` type carrying only `command`/`cwd`/`reason`, so the
 *      broker's file-change payload — the paths "Allow for session" grants a
 *      standing write permission over — never reached the screen.
 */

import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodexApprovalModal from "../../src/client/components/CodexApprovalModal.svelte";
import { API_CODEX_APPROVALS } from "../../src/shared/api-paths.js";
import type { CodexApprovalView } from "../../src/shared/codex/approval.js";
import { API_INTEGRATIONS } from "../../src/shared/integrations/contract.js";

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

const CODEX_ENTRY = { kind: "codex", apply: "create" };
const CLAUDE_ENTRY = { kind: "claude-code", apply: "create" };

function fileChangeApproval(overrides: Partial<CodexApprovalView> = {}): CodexApprovalView {
  return {
    id: "a1",
    kind: "file-change",
    title: "Codex wants to edit 2 files",
    createdAt: 0,
    allowForSession: true,
    changes: [
      { path: "src/a.ts", kind: "update", added: 12, removed: 3 },
      { path: "src/b.ts", kind: "add" },
    ],
    ...overrides,
  };
}

/** Callbacks handed to the stubbed `setInterval`, so a test can drive one more
 *  poll deliberately instead of waiting on wall-clock time. */
let intervalCallbacks: (() => void)[] = [];

/** Payload the stubbed fetch currently serves for `/api/codex/approvals`.
 *  Mutable so a test can change what the NEXT poll returns. */
let servedApprovals: CodexApprovalView[] = [];

/** Records every URL fetched so the "did it poll?" assertions are about calls,
 *  not about rendered output (which would be true for other reasons too).
 *
 *  Each approvals response is re-serialized from scratch, which is the point:
 *  the real fetch hands back a fresh object graph every poll, and that identity
 *  churn is what the focus-stability test needs to reproduce. */
function stubFetch(opts: { integrations: unknown; approvals?: CodexApprovalView[] }): {
  calls: string[];
} {
  const calls: string[] = [];
  servedApprovals = opts.approvals ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes(API_CODEX_APPROVALS)
        ? { approvals: servedApprovals }
        : opts.integrations;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  return { calls };
}

/** Fire one more poll tick, optionally changing what the server returns. */
async function refreshOnce(_container: HTMLElement, next?: CodexApprovalView[]): Promise<void> {
  if (next) servedApprovals = next;
  for (const cb of intervalCallbacks) cb();
  await settle();
}

/** Let the mount's fetch chain settle without leaning on fake timers — the
 *  component awaits two microtask hops (fetch → json) before it renders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("CodexApprovalModal", () => {
  beforeEach(() => {
    intervalCallbacks = [];
    vi.stubGlobal(
      "setInterval",
      // Capture rather than schedule: the 750 ms approval poll and the 30 s
      // config re-read both land here, and a test drives them explicitly.
      vi.fn((cb: () => void) => {
        intervalCallbacks.push(cb);
        return intervalCallbacks.length;
      }),
    );
    vi.stubGlobal("clearInterval", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not poll for approvals when no Codex integration is configured", async () => {
    const { calls } = stubFetch({ integrations: { integrations: [CLAUDE_ENTRY] } });
    render(CodexApprovalModal);
    await settle();
    expect(calls.some((u) => u.includes(API_INTEGRATIONS))).toBe(true);
    expect(calls.some((u) => u.includes(API_CODEX_APPROVALS))).toBe(false);
  });

  // Positive control for the assertion above: the poll is genuinely gated, not
  // simply broken. Same component, same harness, only the config differs.
  it("polls once a Codex integration is configured", async () => {
    const { calls } = stubFetch({ integrations: { integrations: [CODEX_ENTRY] } });
    render(CodexApprovalModal);
    await settle();
    expect(calls.some((u) => u.includes(API_CODEX_APPROVALS))).toBe(true);
  });

  it("treats an apply:skip Codex entry as not configured", async () => {
    const { calls } = stubFetch({
      integrations: { integrations: [{ kind: "codex", apply: "skip" }] },
    });
    render(CodexApprovalModal);
    await settle();
    expect(calls.some((u) => u.includes(API_CODEX_APPROVALS))).toBe(false);
  });

  it("renders the file paths Codex wants to change", async () => {
    stubFetch({
      integrations: { integrations: [CODEX_ENTRY] },
      approvals: [fileChangeApproval()],
    });
    const { container } = render(CodexApprovalModal);
    await settle();
    const changes = byTestId(container, "codex-approval-changes");
    expect(changes).not.toBeNull();
    expect(changes?.textContent).toContain("src/a.ts");
    expect(changes?.textContent).toContain("src/b.ts");
    // The counts are what tell the user how big the edit is.
    expect(changes?.textContent).toContain("+12");
  });

  it("says so explicitly when the change set could not be read", async () => {
    stubFetch({
      integrations: { integrations: [CODEX_ENTRY] },
      // Mirrors the broker: an unreadable change set also forces
      // allowForSession off, so the standing grant is already withheld.
      approvals: [fileChangeApproval({ changes: undefined, allowForSession: false })],
    });
    const { container } = render(CodexApprovalModal);
    await settle();
    expect(byTestId(container, "codex-approval-changes-unreadable")).not.toBeNull();
    expect(byTestId(container, "codex-approval-changes")).toBeNull();
    // "Allow for session" must not be offered without a visible scope.
    expect(container.textContent).not.toContain("Allow for session");
  });

  // `refresh()` assigns a freshly parsed array every poll, so `current`
  // (`$derived(approvals[0])`) changes IDENTITY each time even when the same
  // request is still pending. Keyed on the object, the focus effect re-ran
  // every 750 ms and yanked focus back to Decline — a keyboard user could
  // never reach "Allow once", and text in the file list couldn't be selected.
  it("moves focus to Decline once per approval, not once per poll", async () => {
    const approval = fileChangeApproval();
    stubFetch({ integrations: { integrations: [CODEX_ENTRY] }, approvals: [approval] });
    const { container } = render(CodexApprovalModal);
    await settle();

    const decline = container.querySelector<HTMLButtonElement>("button.secondary");
    expect(decline).not.toBeNull();
    expect(document.activeElement).toBe(decline);

    // Move focus away as a user would, then deliver another poll result
    // carrying the SAME approval as a distinct object (what the real fetch
    // does — this is the exact condition the bug needed).
    const allowOnce = container.querySelector<HTMLButtonElement>("button.primary");
    allowOnce?.focus();
    expect(document.activeElement).toBe(allowOnce);

    await refreshOnce(container);
    expect(document.activeElement).toBe(allowOnce);
  });

  // Positive control for the assertion above: focus DOES still move when the
  // front of the queue becomes a genuinely different request. Without this,
  // "focus didn't move" would also pass with the effect deleted outright.
  it("does move focus when a different approval reaches the front", async () => {
    stubFetch({
      integrations: { integrations: [CODEX_ENTRY] },
      approvals: [fileChangeApproval()],
    });
    const { container } = render(CodexApprovalModal);
    await settle();

    const allowOnce = container.querySelector<HTMLButtonElement>("button.primary");
    allowOnce?.focus();

    await refreshOnce(container, [fileChangeApproval({ id: "a2" })]);
    expect(document.activeElement).toBe(container.querySelector("button.secondary"));
  });

  it("surfaces the grant root when the request carries one", async () => {
    stubFetch({
      integrations: { integrations: [CODEX_ENTRY] },
      approvals: [fileChangeApproval({ grantRoot: "/home/u/project" })],
    });
    const { container } = render(CodexApprovalModal);
    await settle();
    expect(byTestId(container, "codex-approval-grant-root")?.textContent).toContain(
      "/home/u/project",
    );
  });
});
