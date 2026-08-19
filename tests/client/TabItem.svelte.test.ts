// @vitest-environment happy-dom

/**
 * #1447 — the tab's unsaved dot.
 *
 * The client cannot derive "unsaved" on its own: the initial CRDT sync and an
 * MCP edit that landed before the window attached are the same bytes arriving in
 * the same sync. So `TabItem` arms 500 ms after mount, and the value it arms to
 * is the server's authoritative `Y_MAP_DIRTY` mirror rather than a hardcoded
 * `false`. Both behaviours have to hold at once — a pre-attach edit shows a dot,
 * AND a plain clean load does not — so they are tested as a pair that differs in
 * exactly one dimension: whether the mirror key rides along with the content.
 */

import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import TabItem from "../../src/client/tabs/TabItem.svelte";
import type { OpenTab } from "../../src/client/types.js";
import {
  Y_MAP_DIRTY,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";

/** TabItem's arm delay. */
const ARM_MS = 500;
/** TabItem's save-confirmation flash duration. */
const SAVE_CONFIRM_MS = 600;

// Real timers, deliberately. Fake timers would need `advanceTimersByTime`, and
// `@testing-library/svelte`'s auto-cleanup never registers in this repo (the
// `client` vitest project sets no `globals` and no `setupFiles`), so a previous
// test's still-mounted component would have its 500 ms arm and 600 ms flash
// timers fire inside a later test's clock. Every test unmounts explicitly; the
// waits below are well inside the client project's 5 s default timeout.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const afterArm = () => wait(ARM_MS + 80);

function makeTab(id: string, ydoc: Y.Doc): OpenTab {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `/tmp/${id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
    ydoc,
    // TabItem never touches the provider on these paths.
    provider: {} as unknown as OpenTab["provider"],
  };
}

function mount(id: string, ydoc: Y.Doc) {
  const result = render(TabItem, {
    props: {
      tab: makeTab(id, ydoc),
      isActive: true,
      onswitch: vi.fn(),
      onclose: vi.fn(),
      onpointerdown: vi.fn(),
      dropIndicator: null,
      onkeydown: vi.fn(),
    },
  });
  const indicator = () =>
    result.container.querySelector<HTMLElement>(`[data-testid="unsaved-indicator-${id}"]`);
  return {
    unmount: result.unmount,
    /** True when the unsaved dot is rendered. */
    hasDot: () => Boolean(indicator()?.querySelector(".dot")),
    /** True when the A2 save-confirmation check is rendered. */
    hasCheck: () => Boolean(indicator()?.querySelector(".saved-check")),
  };
}

/**
 * Everything a document's room delivers arrives over the provider AFTER mount —
 * in production the tab's Y.Doc is constructed empty (hooks/yjsSync.svelte.ts).
 * `syncContent` is the body half of that sync, `setMirror` the server's flag.
 */
function syncContent(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [p]);
}

function setMirror(ydoc: Y.Doc, value: boolean): void {
  ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_DIRTY, value);
}

describe("TabItem unsaved dot — pre-attach edits (#1447)", () => {
  it("C1: shows the dot when the pre-attach edit syncs in DURING the arm window", async () => {
    // The issue's repro at component level: `tandem_edit` ran before any window
    // attached, so the edit and the server's dirty flag both arrive in the
    // initial sync. Before the fix the arm callback set `dirty = false`
    // unconditionally and the tab showed clean over genuinely unsaved work.
    const ydoc = new Y.Doc();
    const tab = mount("pre-attach", ydoc);

    syncContent(ydoc, "text Claude wrote before the window existed");
    setMirror(ydoc, true);

    await afterArm();
    expect(tab.hasDot()).toBe(true);
    tab.unmount();
  });

  it("C2: shows the dot when the sync lands AFTER the arm window", async () => {
    // Same edit, slower sync. This one the fragment observer alone would catch;
    // it is here so C1's failure can't be read as "the tab never updates".
    const ydoc = new Y.Doc();
    const tab = mount("late-sync", ydoc);

    await afterArm();
    expect(tab.hasDot()).toBe(false);

    syncContent(ydoc, "arrived late");
    setMirror(ydoc, true);
    await wait(20);
    expect(tab.hasDot()).toBe(true);
    tab.unmount();
  });

  it("C3: shows the dot when the mirror flips true with no body change at all", async () => {
    // Server-side `markDirty` with no content edit — e.g. a restored session
    // whose unsaved edits were never persisted (#1069). The local fragment
    // observer cannot see this; only the mirror can.
    const ydoc = new Y.Doc();
    const tab = mount("no-body-change", ydoc);

    await afterArm();
    expect(tab.hasDot()).toBe(false);

    setMirror(ydoc, true);
    await wait(20);
    expect(tab.hasDot()).toBe(true);
    tab.unmount();
  });

  it("C4: stays clean on a normal load — content syncs in during the arm window, no mirror", async () => {
    // The guard the fix must not break. Identical to C1 except the mirror key is
    // absent, so it fences the naive "if there's content, start dirty" fix: the
    // arm-time reset is still what stops every tab opening dirty.
    const ydoc = new Y.Doc();
    const tab = mount("clean-load", ydoc);

    syncContent(ydoc, "a document opened to read");

    await afterArm();
    expect(tab.hasDot()).toBe(false);
    tab.unmount();
  });

  it("C5: stays clean when the mirror explicitly says false", async () => {
    const ydoc = new Y.Doc();
    setMirror(ydoc, false);
    const tab = mount("mirror-false", ydoc);

    syncContent(ydoc, "clean content");

    await afterArm();
    expect(tab.hasDot()).toBe(false);
    tab.unmount();
  });
});

describe("TabItem unsaved dot — clearing (#1447)", () => {
  it("C6: a save clears the dot and flashes the check", async () => {
    const ydoc = new Y.Doc();
    const tab = mount("saved", ydoc);
    syncContent(ydoc, "edited");
    setMirror(ydoc, true);

    await afterArm();
    expect(tab.hasDot()).toBe(true);

    // saveDocumentToDisk: savedAtVersion first, then markCleanIfUnchanged →
    // the mirror flips false in a separate transaction.
    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now());
    setMirror(ydoc, false);
    await wait(20);

    expect(tab.hasDot()).toBe(false);
    expect(tab.hasCheck()).toBe(true);
    await wait(SAVE_CONFIRM_MS + 80);
    expect(tab.hasCheck()).toBe(false);
    tab.unmount();
  });

  it("C7: a save that LOST the mid-write race must not clear the dot", async () => {
    // `saveDocumentToDisk` writes Y_MAP_SAVED_AT_VERSION (document-service.ts)
    // BEFORE calling markCleanIfUnchanged, and that call refuses to clear when a
    // body edit landed during the async write. The mirror therefore stays true
    // and no further meta write happens — so the savedAtVersion event is the
    // only thing the client sees. Clearing on it unconditionally shows a clean
    // tab over unpersisted edits, which is #1447 again by another route.
    const ydoc = new Y.Doc();
    const tab = mount("lost-race", ydoc);
    syncContent(ydoc, "first");
    setMirror(ydoc, true);

    await afterArm();
    expect(tab.hasDot()).toBe(true);

    // The mid-write edit, then the save's savedAtVersion stamp. The mirror is
    // NOT rewritten — the server never transitioned back to clean.
    syncContent(ydoc, "landed during the write");
    ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now());
    await wait(20);

    expect(tab.hasDot()).toBe(true);
    tab.unmount();
  });

  it("C8: an unrelated documentMeta write must not re-assert a stale mirror level", async () => {
    // `onMetaChange` fires on ANY documentMeta key — externalConflict,
    // fidelityReport, readOnly, fileName/format, openDocuments. Reading the
    // mirror as a level rather than an edge would let one of those writes
    // re-assert whatever the map happens to hold and latch the tab against the
    // user's own live typing.
    const ydoc = new Y.Doc();
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
    const tab = mount("stale-level", ydoc);

    // Saved state: the map holds `false`.
    setMirror(ydoc, false);
    await afterArm();
    expect(tab.hasDot()).toBe(false);

    // The user types. The server's mirror write is still in flight.
    syncContent(ydoc, "user typing");
    await wait(20);
    expect(tab.hasDot()).toBe(true);

    // An unrelated meta write lands first.
    meta.set(Y_MAP_EXTERNAL_CONFLICT, { kind: "modified" });
    await wait(20);
    expect(tab.hasDot()).toBe(true);
    tab.unmount();
  });
});
