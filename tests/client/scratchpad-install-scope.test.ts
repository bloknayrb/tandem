import type { HocuspocusProvider } from "@hocuspocus/provider";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createScratchpadPersistence,
  scratchpadStorageKey,
} from "../../src/client/hooks/useScratchpadPersistence.svelte";
import type { OpenTab } from "../../src/client/types";

/**
 * #1387 — scratchpad recovery must not cross installations.
 *
 * Every Tandem server on a machine shares one browser origin, so `localStorage`
 * written while talking to one server is visible to all of them. Recovery keys
 * carried only a UUID, and a *fresh* scratchpad has no key of its own — so the
 * latest-pointer fallback would hand it whatever the last server persisted.
 * In practice that meant a real document's content being written into a
 * scratchpad on a test server, and the test's typing persisted back under the
 * real profile.
 *
 * This is the regression that turns the fix on. `restoreInto` had no unit
 * coverage at all before it — `tests/client/scratchpad-persistence.test.ts`
 * only exercises the pure exports — so the behaviour these tests pin was
 * previously asserted nowhere.
 */

const INSTALL_A = "aaaa1111";
const INSTALL_B = "bbbb2222";
const UUID_OLD = "11111111-1111-4111-8111-111111111111";
const UUID_NEW = "22222222-2222-4222-8222-222222222222";

/** Minimal stand-in: the hook only ever touches `synced`, `on` and `off`. */
function fakeProvider(): HocuspocusProvider {
  return {
    synced: true,
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
}

function scratchpadTab(uuid: string, ydoc: Y.Doc): OpenTab {
  return {
    id: `doc-${uuid}`,
    filePath: `upload://scratchpad/${uuid}/Scratchpad.md`,
    fileName: "Scratchpad.md",
    format: "markdown",
    readOnly: false,
    source: "upload",
    ydoc,
    provider: fakeProvider(),
  };
}

function textOf(ydoc: Y.Doc): string {
  return ydoc.getXmlFragment("default").toString();
}

/**
 * Seed recovery data as if a previous session on `installId` had persisted it.
 * Mirrors `persistEntry`'s two writes — content key plus latest pointer.
 *
 * Deliberately builds the keys as LITERALS rather than calling
 * `scratchpadStorageKey`. Seeding through the function under test makes the
 * seed move with it: a mutation that drops the install segment changes both
 * the write and the read, and every assertion here still passes. That mutant
 * genuinely survived until this helper stopped sharing the implementation.
 */
function contentKey(installId: string, uuid: string): string {
  return `tandem:scratchpad:${installId}:${uuid}`;
}

function latestKey(installId: string): string {
  return `tandem:scratchpad:${installId}:latest`;
}

function seedRecovery(installId: string, uuid: string, text: string): void {
  localStorage.setItem(contentKey(installId, uuid), JSON.stringify([text]));
  localStorage.setItem(latestKey(installId), uuid);
}

let stop: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  localStorage.clear();
});

/** Attach the hook to a single scratchpad tab and let its diff effect run. */
function attachTo(ydoc: Y.Doc, uuid: string, installId: string | null) {
  const tabs = [scratchpadTab(uuid, ydoc)];
  const persistence = createScratchpadPersistence(
    () => tabs,
    () => installId,
  );
  stop = persistence.destroy;
  flushSync();
  return persistence;
}

describe("scratchpad recovery is scoped to the installation", () => {
  it("agrees with the implementation on the key layout", () => {
    // The seed helpers above build keys by hand so they cannot move with a
    // mutation. That independence is only safe if they match the real layout,
    // which is what this pins — otherwise every test below would seed data the
    // hook never reads and pass for the wrong reason.
    expect(contentKey(INSTALL_A, UUID_OLD)).toBe(scratchpadStorageKey(INSTALL_A, UUID_OLD));
  });

  it("restores content persisted by the SAME installation", () => {
    // The feature this fix must not break: reopening a scratchpad on your own
    // server still recovers what you were writing.
    seedRecovery(INSTALL_A, UUID_OLD, "my unsaved draft");
    const ydoc = new Y.Doc();
    attachTo(ydoc, UUID_NEW, INSTALL_A);

    expect(textOf(ydoc)).toContain("my unsaved draft");
  });

  it("does NOT restore content persisted by a DIFFERENT installation", () => {
    // The leak. A scratchpad opened on a server that never persisted anything
    // must come up empty, even though the browser holds recovery data for a
    // different server at the same origin.
    seedRecovery(INSTALL_A, UUID_OLD, "a real document's contents");
    const ydoc = new Y.Doc();
    attachTo(ydoc, UUID_NEW, INSTALL_B);

    expect(textOf(ydoc)).toBe("");
  });

  it("does NOT restore while the install id is unknown", () => {
    // Fail closed. Before `/api/info` answers there is no key that can be
    // scoped correctly, and guessing one is the bug with extra steps.
    seedRecovery(INSTALL_A, UUID_OLD, "a real document's contents");
    const ydoc = new Y.Doc();
    attachTo(ydoc, UUID_NEW, null);

    expect(textOf(ydoc)).toBe("");
  });

  it("refuses outright rather than falling back to a placeholder namespace", () => {
    // The previous test cannot tell "refuse" from "substitute some other
    // string", because either way the INSTALL_A data is missed. A `?? "unknown"`
    // in place of the guard passed it — and that is a real leak, just a narrow
    // one: every client whose install id is unknown would then share one
    // namespace, so content persisted during the pre-`/api/info` window on any
    // server restores on any other. Seeding that exact namespace is what makes
    // the distinction observable.
    localStorage.setItem(contentKey("unknown", UUID_OLD), JSON.stringify(["placeholder ns"]));
    localStorage.setItem(latestKey("unknown"), UUID_OLD);
    const ydoc = new Y.Doc();
    attachTo(ydoc, UUID_NEW, null);

    expect(textOf(ydoc)).toBe("");
  });

  it("purges the pre-fix unscoped keys instead of leaving them addressable by nobody", () => {
    // After the fix nothing reads `tandem:scratchpad:<uuid>`, so left alone it
    // holds document text in the browser forever — and it is exactly the text
    // that crossed installs. Deletion is not a new loss: declining to read
    // these already gave it up.
    localStorage.setItem("tandem:scratchpad:legacy-uuid", JSON.stringify(["old draft"]));
    localStorage.setItem("tandem:scratchpad:latest", "legacy-uuid");
    seedRecovery(INSTALL_A, UUID_OLD, "still mine");

    attachTo(new Y.Doc(), UUID_NEW, INSTALL_A);

    expect(localStorage.getItem("tandem:scratchpad:legacy-uuid")).toBeNull();
    expect(localStorage.getItem("tandem:scratchpad:latest")).toBeNull();
    // The purge is shape-based, so a scoped key must survive it — a sweep that
    // ate those would delete live recovery on every boot.
    expect(localStorage.getItem(latestKey(INSTALL_A))).not.toBeNull();
  });

  it("leaves same-shaped keys belonging to other features alone", () => {
    // The purge matches on segment count, so the `tandem:scratchpad:` prefix
    // check is the only thing standing between it and a real neighbour:
    // `tandem:headingCollapse:<docId>` is also three segments under `tandem:`.
    // Widen or drop that check and every user silently loses heading-collapse
    // state on every app start.
    localStorage.setItem("tandem:headingCollapse:doc123", '{"h1":true}');
    localStorage.setItem("tandem:showAuthorship", "true");

    attachTo(new Y.Doc(), UUID_NEW, INSTALL_A);

    expect(localStorage.getItem("tandem:headingCollapse:doc123")).toBe('{"h1":true}');
    expect(localStorage.getItem("tandem:showAuthorship")).toBe("true");
  });

  it("keeps a foreign installation's recovery data intact", () => {
    // Declining to restore must not also destroy the other installation's
    // recovery: the restore path rewrites the latest pointer and deletes the
    // source key, so a partial application of the fix could silently discard
    // the user's real draft instead of merely ignoring it.
    seedRecovery(INSTALL_A, UUID_OLD, "a real document's contents");
    const ydoc = new Y.Doc();
    attachTo(ydoc, UUID_NEW, INSTALL_B);

    expect(localStorage.getItem(contentKey(INSTALL_A, UUID_OLD))).toContain(
      "a real document's contents",
    );
    expect(localStorage.getItem(latestKey(INSTALL_A))).toBe(UUID_OLD);
  });
});
