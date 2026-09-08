import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveSkippedMessage,
  saveStore,
  triggerSave,
} from "../../../src/client/actions/builtin.svelte";
import { type ActionExecutor, mountActionExecutor } from "../../../src/client/actions/executor.js";
import { makeActionDeps } from "./deps-bag.js";

/** Did `notify` fire with this severity and a message containing `substring`?
 *
 * Asserted over `mock.calls` rather than with `toHaveBeenCalledWith`, which
 * matches on the FULL argument list: `notifyUser` always forwards a third
 * `opts` argument (usually `undefined`), so a two-argument expectation silently
 * stops matching — and its `.not.` form silently starts passing vacuously. */
function notified(
  notify: { mock: { calls: unknown[][] } },
  severity: string,
  substring: string,
): boolean {
  return notify.mock.calls.some(
    ([sev, msg]) => sev === severity && typeof msg === "string" && msg.includes(substring),
  );
}

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

/** Bind the action deps with a document path (the only field that varies).
 *
 * `triggerSave` is exported and driven directly here, NOT through an action —
 * it reaches `notify` via `currentActionDeps()`, which is exactly why that
 * accessor exists. Routing this file through `mountActionExecutor` is what
 * proves the accessor covers the non-action callers. */
let executor: ActionExecutor | null = null;
const wireDeps = (notify: (...args: unknown[]) => void, path: string): void => {
  executor = mountActionExecutor(makeActionDeps({ notify, getActiveDocumentPath: () => path }));
};

// File-level, not per-describe: every block here binds an executor, and a leaked
// one stays module-global and would leak `notify` into the next file.
afterEach(() => {
  executor?.dispose();
  executor = null;
  vi.unstubAllGlobals();
});

describe("triggerSave / saveStore.lastSaveOk", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    wireDeps(notify, "/tmp/doc.md");
  });

  it("sets lastSaveOk=true after a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ status: "saved" })));
    await expect(triggerSave("doc-1")).resolves.toBe(true);
    expect(saveStore.lastSaveOk).toBe(true);
    expect(saveStore.saving).toBe(false);
    expect(notify.mock.calls.filter(([sev]) => sev === "error")).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("sets lastSaveOk=false and notifies on a failed (non-ok) response", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchFail));
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(saveStore.lastSaveOk).toBe(false);
    expect(saveStore.saving).toBe(false);
    expect(notified(notify, "error", "disk full")).toBe(true);
    vi.unstubAllGlobals();
  });

  // #1816: a 200 body reporting `status: "error"` (document-service.ts's own
  // scrubbed reason) still carries `errorCode` — triggerSave renders it as a
  // parenthetical details suffix, the client-side layer distinct from (and
  // unaffected by) the server's own `pushNotification` scrub.
  it("appends the errno as a details suffix when the result carries one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        fetchWith({
          status: "error",
          reason: "The document could not be saved.",
          errorCode: "EACCES",
        }),
      ),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(
      notified(notify, "error", "Save failed: The document could not be saved. (EACCES)"),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  // (post-ship review of #1816/#1897) `result.errorCode` can be "UNKNOWN"
  // (document-service.ts's own catch-all fallback) or "VERIFY_BLOCKED"
  // (`SaveVerificationError`, whose `reason` is already a deliberately
  // complete, content-free sentence) — neither should get the jargon suffix.
  it('omits the suffix for the "UNKNOWN" fallback code', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        fetchWith({
          status: "error",
          reason: "The document could not be saved.",
          errorCode: "UNKNOWN",
        }),
      ),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(notified(notify, "error", "Save failed: The document could not be saved.")).toBe(true);
    expect(notified(notify, "error", "(UNKNOWN)")).toBe(false);
    vi.unstubAllGlobals();
  });

  it('omits the suffix for "VERIFY_BLOCKED" — its reason is already complete', async () => {
    const reason =
      "the regenerated file did not re-open cleanly — your original file was left unchanged";
    vi.stubGlobal(
      "fetch",
      vi.fn(fetchWith({ status: "error", reason, errorCode: "VERIFY_BLOCKED" })),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(notified(notify, "error", `Save failed: ${reason}`)).toBe(true);
    expect(notified(notify, "error", "(VERIFY_BLOCKED)")).toBe(false);
    vi.unstubAllGlobals();
  });

  // cr-3 (J2 review round 3): the client always prefixes the server's
  // `reason` with "Save failed: " — a reason that (redundantly) repeats
  // "save failed" itself stutters. Pins that the server's own generic
  // fallback text (not just this test's fixture) doesn't reintroduce it.
  it("does not stutter 'Save failed: The save failed.' on the generic fallback reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fetchWith({ status: "error", reason: "The document could not be saved." })),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(notified(notify, "error", "The save failed.")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("sets lastSaveOk=false and notifies when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(saveStore.lastSaveOk).toBe(false);
    expect(saveStore.saving).toBe(false);
    expect(notified(notify, "error", "try again")).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("saveSkippedMessage", () => {
  it.each([
    ["EXTERNAL_CONFLICT", "changed on disk"],
    ["PROMOTION_REQUIRED", "Save As"],
    ["READ_ONLY", "read-only"],
    ["UNSUPPORTED_FORMAT", "format"],
    ["SAVE_IN_PROGRESS", "already in progress"],
    ["SOURCE_MISSING", "no longer exists"],
  ])("maps %s to honest user-facing copy", (code, expected) => {
    expect(saveSkippedMessage(code)).toContain(expected);
  });

  it("uses a reason from an older server without claiming success", () => {
    expect(saveSkippedMessage(undefined, "Legacy skip")).toBe("Not saved — Legacy skip.");
  });

  it("keeps the Saved flash off for every skipped response", async () => {
    const notify = vi.fn();
    wireDeps(notify, "/tmp/doc.md");
    vi.stubGlobal(
      "fetch",
      vi.fn(fetchWith({ status: "skipped", skipCode: "READ_ONLY", reason: "Read-only" })),
    );
    await expect(triggerSave("doc-1")).resolves.toBe(false);
    expect(saveStore.lastSaveOk).toBe(false);
    expect(notified(notify, "warning", "read-only")).toBe(true);
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

  const warnings = () => notify.mock.calls.filter(([level]) => level === "warning");

  it("says nothing at all on a clean save", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ status: "saved" })));
    await triggerSave("doc-1");
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports export downgrades with a count (that count is real)", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ status: "saved", fidelityWarnings: ["a", "b"] })));
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("2 Word features were simplified");
  });

  it("reports unpreserved imports WITHOUT a number", async () => {
    // unpreservedImports counts capped report LINES, so publishing it as a
    // feature count would be a falsifiable claim on an honesty surface.
    vi.stubGlobal("fetch", vi.fn(fetchWith({ status: "saved", unpreservedImports: 3 })));
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("backed-up original");
    expect(warnings()[0][1]).not.toContain("3");
  });

  it("merges both facts into ONE toast, never a third", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fetchWith({ status: "saved", fidelityWarnings: ["a"], unpreservedImports: 2 })),
    );
    await triggerSave("doc-1");
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toContain("1 Word feature was simplified");
    expect(warnings()[0][1]).toContain("backed-up original");
  });

  it("agrees the verb with the count (1 was / 2 were)", async () => {
    vi.stubGlobal("fetch", vi.fn(fetchWith({ status: "saved", fidelityWarnings: ["a"] })));
    await triggerSave("doc-1");
    expect(warnings()[0][1]).toContain("1 Word feature was simplified");
  });

  it("keeps the integrity error toast distinct and unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fetchWith({ status: "saved", integrityWarnings: ["y"], unpreservedImports: 2 })),
    );
    await triggerSave("doc-1");
    expect(notified(notify, "error", "backed up")).toBe(true);
    expect(warnings()).toHaveLength(1); // the unpreserved half still speaks
  });
});
