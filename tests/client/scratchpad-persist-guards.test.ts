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
