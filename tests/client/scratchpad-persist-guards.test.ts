import type { HocuspocusProvider } from "@hocuspocus/provider";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createScratchpadPersistence } from "../../src/client/hooks/useScratchpadPersistence.svelte";
import type { OpenTab } from "../../src/client/types";

/**
 * The write side of scratchpad recovery, plus the guards around it (#1387).
 *
 * `scratchpad-install-scope.test.ts` covers restore. Everything here is the
 * direction it cannot see: what `persistEntry` writes, what `clearUnsaved`
 * removes, and — most importantly — what the fail-closed install-id guard is
 * allowed to suppress. The guard protects STORAGE. A review found it had been
 * written to suppress the unsaved-content warning too, which turns a content
 * leak into silent content loss; these tests exist so that cannot come back.
 *
 * Persist is debounced, so every test drives it with fake timers.
 */

const INSTALL_A = "aaaa1111";
const UUID = "11111111-1111-4111-8111-111111111111";
const PERSIST_MS = 500;

function contentKey(installId: string, uuid: string): string {
  return `tandem:scratchpad:${installId}:${uuid}`;
}

function latestKey(installId: string): string {
  return `tandem:scratchpad:${installId}:latest`;
}

/**
 * Provider stand-in whose `synced` state is controllable. `emitSynced()` fires
 * the one-shot listener `attach` registers when a tab is not yet synced — the
 * branch every existing test skips by passing `synced: true`.
 */
function fakeProvider(synced: boolean) {
  const handlers = new Set<() => void>();
  const provider = {
    synced,
    on: (event: string, fn: () => void) => {
      if (event === "synced") handlers.add(fn);
    },
    off: (event: string, fn: () => void) => {
      if (event === "synced") handlers.delete(fn);
    },
  };
  return {
    provider: provider as unknown as HocuspocusProvider,
    emitSynced: () => {
      for (const fn of [...handlers]) fn();
    },
  };
}

function scratchpadTab(uuid: string, ydoc: Y.Doc, provider: HocuspocusProvider): OpenTab {
  return {
    id: `doc-${uuid}`,
    filePath: `upload://scratchpad/${uuid}/Scratchpad.md`,
    fileName: "Scratchpad.md",
    format: "markdown",
    readOnly: false,
    source: "upload",
    ydoc,
    provider,
  };
}

/** Type a paragraph into a scratchpad's Y.Doc, as the editor would. */
function type(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  ydoc.transact(() => {
    fragment.insert(fragment.length, [p]);
  });
}

/** Remove everything from a scratchpad, as select-all + delete would. */
function clearDoc(ydoc: Y.Doc): void {
  const fragment = ydoc.getXmlFragment("default");
  ydoc.transact(() => {
    fragment.delete(0, fragment.length);
  });
}

let stop: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * Attach the hook to one scratchpad tab. The install id is read through a
 * mutable box so a test can flip it null → known the way `/api/info` does.
 */
function harness(opts: { installId: string | null; synced?: boolean }) {
  const box = { id: opts.installId };
  const ydoc = new Y.Doc();
  const { provider, emitSynced } = fakeProvider(opts.synced ?? true);
  const tabs = [scratchpadTab(UUID, ydoc, provider)];
  const persistence = createScratchpadPersistence(
    () => tabs,
    () => box.id,
  );
  stop = persistence.destroy;
  flushSync();
  return { ydoc, persistence, box, emitSynced };
}

describe("persistEntry", () => {
  it("writes the content key and the latest pointer under the install", () => {
    const { ydoc } = harness({ installId: INSTALL_A });
    type(ydoc, "draft text");
    vi.advanceTimersByTime(PERSIST_MS);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toContain("draft text");
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBe(UUID);
  });

  it("writes NOTHING while the install id is unknown", () => {
    // The write half of fail-closed. The restore-side tests cannot see this:
    // a `?? "unknown"` applied only here still passes them, while pooling every
    // install's document text into one shared key — the #1387 shape, waiting
    // for anyone to relax the read guard.
    const { ydoc } = harness({ installId: null });
    type(ydoc, "draft text");
    vi.advanceTimersByTime(PERSIST_MS);

    const keys = Object.keys(localStorage).filter((k) => k.startsWith("tandem:scratchpad:"));
    expect(keys).toEqual([]);
  });

  it("STILL warns about unsaved content when the install id is unknown", () => {
    // The regression this file exists for. The fail-closed guard governs
    // storage only: content we could not persist is content the user is more
    // likely to lose, so suppressing the warning there is exactly backwards —
    // the tab would close with no prompt and no recovery net.
    const { ydoc, persistence } = harness({ installId: null });
    type(ydoc, "draft text");
    vi.advanceTimersByTime(PERSIST_MS);

    expect(persistence.hasUnsavedContent(UUID)).toBe(true);
  });

  it("clears the content key and the pointer when the scratchpad is emptied", () => {
    // Otherwise the next fresh scratchpad restores text the user deleted on
    // purpose, and the close warning fires over a visibly empty pad.
    const { ydoc, persistence } = harness({ installId: INSTALL_A });
    type(ydoc, "draft text");
    vi.advanceTimersByTime(PERSIST_MS);
    clearDoc(ydoc);
    vi.advanceTimersByTime(PERSIST_MS);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toBeNull();
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBeNull();
    expect(persistence.hasUnsavedContent(UUID)).toBe(false);
  });
});

describe("clearUnsaved", () => {
  it("removes both keys so a discarded draft cannot come back", () => {
    const { ydoc, persistence } = harness({ installId: INSTALL_A });
    type(ydoc, "about to be discarded");
    vi.advanceTimersByTime(PERSIST_MS);

    persistence.clearUnsaved(UUID);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toBeNull();
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBeNull();
    expect(persistence.hasUnsavedContent(UUID)).toBe(false);
  });

  it("clears the flag even when the install id is unknown", () => {
    // Deliberately NOT fail-closed, and the asymmetry is load-bearing: adding
    // the storage guard here "for consistency" latches the flag true forever,
    // because detach() runs immediately after and nothing recomputes it. The
    // close dialog would then re-fire on every attempt and `beforeunload` would
    // warn permanently.
    const { ydoc, persistence } = harness({ installId: null });
    type(ydoc, "about to be discarded");
    vi.advanceTimersByTime(PERSIST_MS);
    expect(persistence.hasUnsavedContent(UUID)).toBe(true);

    persistence.clearUnsaved(UUID);

    expect(persistence.hasUnsavedContent(UUID)).toBe(false);
  });
});

describe("restore deferred until the provider syncs", () => {
  it("recovers a draft for a tab that attaches before sync", () => {
    // The one-shot `synced` path. Every other test passes `synced: true` and
    // skips it entirely — so hoisting the `getInstallId()` read up into
    // attach(), an obvious "read it once" cleanup, would kill recovery for
    // real tabs (which attach unsynced) without failing anything.
    localStorage.setItem(contentKey(INSTALL_A, UUID), JSON.stringify(["recovered draft"]));
    localStorage.setItem(latestKey(INSTALL_A), UUID);

    const { ydoc, emitSynced } = harness({ installId: INSTALL_A, synced: false });
    expect(ydoc.getXmlFragment("default").toString()).toBe("");

    emitSynced();

    expect(ydoc.getXmlFragment("default").toString()).toContain("recovered draft");
  });

  it("reads the install id at sync time, not at attach time", () => {
    // `/api/info` answers asynchronously, so a tab can attach while the id is
    // still null. Recovery must survive that — which it does only because
    // restoreInto re-reads the accessor when `synced` fires.
    localStorage.setItem(contentKey(INSTALL_A, UUID), JSON.stringify(["recovered draft"]));
    localStorage.setItem(latestKey(INSTALL_A), UUID);

    const { ydoc, box, emitSynced } = harness({ installId: null, synced: false });
    box.id = INSTALL_A;
    emitSynced();

    expect(ydoc.getXmlFragment("default").toString()).toContain("recovered draft");
  });

  it("warns rather than failing silently when the id never arrives", () => {
    // Restore is one-shot, so this is terminal for the tab: the user sees an
    // empty scratchpad and cannot tell it from "nothing to recover". The warning
    // is the only artifact anyone debugging it would have.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(contentKey(INSTALL_A, UUID), JSON.stringify(["recovered draft"]));
    localStorage.setItem(latestKey(INSTALL_A), UUID);

    const { ydoc, emitSynced } = harness({ installId: null, synced: false });
    emitSynced();

    expect(ydoc.getXmlFragment("default").toString()).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Scratchpad recovery skipped"));
  });
});

const INSTALL_B = "bbbb2222";

describe("install id locks to the entry, surviving a later live change", () => {
  // A generation-rebuild (server swapped behind the same host:port — e.g.
  // `npm run test:e2e` killing and replacing a dev server on :3478/:3479)
  // updates the live install id BEFORE tearing tabs down, and `detach()`
  // flushes each entry's pending debounced write as part of that teardown.
  // Reading `getInstallId()` live at flush time would persist content typed
  // under the OLD server under the NEW server's key — the #1387 leak,
  // reopened through the teardown path instead of the initial-open one these
  // tests can't otherwise see. These tests flip the live id directly (the
  // same shape a rebuild produces) without needing to drive the reactive
  // tabs-diff effect that would normally trigger it.

  it("persistEntry keeps writing under the id locked when the entry first resolved it", () => {
    const { ydoc, box } = harness({ installId: INSTALL_A }); // locks to A via restoreInto at attach
    type(ydoc, "typed while still on A");
    box.id = INSTALL_B; // the live id moves on before the debounce fires
    vi.advanceTimersByTime(PERSIST_MS);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toContain("typed while still on A");
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBe(UUID);
    expect(localStorage.getItem(contentKey(INSTALL_B, UUID))).toBeNull();
    expect(localStorage.getItem(latestKey(INSTALL_B))).toBeNull();
  });

  it("clearUnsaved removes the locked install's key, not the live-changed one", () => {
    const { ydoc, persistence, box } = harness({ installId: INSTALL_A });
    type(ydoc, "about to be discarded");
    vi.advanceTimersByTime(PERSIST_MS);
    box.id = INSTALL_B; // live id moves on before the confirmed-close callback runs

    persistence.clearUnsaved(UUID);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toBeNull();
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBeNull();
  });

  it("locks at attach() itself, not deferred to the synced listener", () => {
    // A first pass at this fix locked lazily, in whichever of restoreInto /
    // persistEntry / detach's flush happened to call resolveInstallId first.
    // For a tab that attaches unsynced, that let a live id change BEFORE the
    // synced listener ever fires decide the lock — this pins that attach()
    // grabs the live id immediately instead, so a later change (here, before
    // sync even completes) cannot touch it.
    const { ydoc, box, emitSynced } = harness({ installId: INSTALL_A, synced: false });
    box.id = INSTALL_B; // flips before synced fires — must NOT become the lock
    emitSynced();

    type(ydoc, "typed after sync, still locked to A");
    vi.advanceTimersByTime(PERSIST_MS);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toContain(
      "typed after sync, still locked to A",
    );
    expect(localStorage.getItem(contentKey(INSTALL_B, UUID))).toBeNull();
  });

  it("survives a rebuild that completes before the entry ever synced", () => {
    // The gap a review found in the first pass: an entry whose provider never
    // syncs before a rebuild tears it down defers restoreInto — and so its
    // lock attempt — behind the one-shot `synced` listener that never fires.
    // If the entry's first-ever resolveInstallId call were the detach flush
    // itself (post-rebuild, live id already the NEW server's), content typed
    // under the OLD server would lock onto — and persist under — the new
    // one. Locking eagerly in attach() closes this: the entry captures A the
    // moment it opens, before sync, before typing, before any rebuild could
    // occur.
    const { ydoc, box, persistence } = harness({ installId: INSTALL_A, synced: false });
    type(ydoc, "typed before this room ever synced");
    box.id = INSTALL_B; // rebuild's fetchServerIdentity() resolves the new id...
    persistence.destroy(); // ...then teardownAllTabs() detaches and flushes — never synced

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID))).toContain(
      "typed before this room ever synced",
    );
    expect(localStorage.getItem(contentKey(INSTALL_B, UUID))).toBeNull();
  });
});
