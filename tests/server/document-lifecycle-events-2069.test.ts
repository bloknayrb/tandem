/**
 * #2069: `document:opened` / `closed` / `switched` fire in production.
 *
 * Driven through the REAL registry composites (`openDocument`,
 * `activateDocument`, `closeDocument`), whose one broadcast writes CTRL_ROOM's
 * `documentMeta` under `withInternal` — the origin that used to make the
 * ctrl-meta observer skip every one of them. A test that writes the keys by
 * hand under some other origin is exactly how the bug stayed green.
 *
 * Also pins what must NOT change with them: the Solo hold and the licence
 * refusal on the external path, and that none of the three is wake-worthy.
 *
 * The licence gate is ARMED for this file (as in
 * `license-armed-restricted.test.ts`); a fresh trial admits, an expired one
 * refuses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

import {
  activateDocument,
  broadcastOpenDocs,
  closeDocument,
  getOpenDocs,
  openDocument,
} from "../../src/server/documents/registry.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  attachCtrlObservers,
  replaySince,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { aiRefusal } from "../../src/server/license/ai-refusal.js";
import { trialFilePath } from "../../src/server/license/paths.js";
import { isStartWorthy, isWakeWorthy } from "../../src/shared/events/wake-scope.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";

const DAY = 86_400_000;
const createdDirs: string[] = [];
const savedAppDataDir = process.env.TANDEM_APP_DATA_DIR;

function useTrial(daysAgo: number): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-lifecycle-2069-"));
  createdDirs.push(dir);
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(Date.now() - daysAgo * DAY).toISOString() }),
  );
  process.env.TANDEM_APP_DATA_DIR = dir;
}

function doc(id: string) {
  return {
    id,
    filePath: path.join(os.tmpdir(), `${id}.md`),
    format: "md",
    readOnly: false,
    source: "file" as const,
  };
}

function collect(kind: "internal" | "external") {
  const events: TandemEvent[] = [];
  const cb = (e: TandemEvent) => events.push(e);
  subscribe(cb, kind);
  return { lifecycle: () => events.filter((e) => e.type.startsWith("document:")), cb };
}

/** Open two tabs, switch back to the first, close the second. */
function tabSession(): void {
  openDocument(doc("doc-a"));
  openDocument(doc("doc-b"));
  activateDocument("doc-a");
  closeDocument("doc-b");
}

const EXPECTED = [
  ["document:opened", "doc-a"],
  ["document:switched", "doc-a"],
  ["document:opened", "doc-b"],
  ["document:switched", "doc-b"],
  ["document:switched", "doc-a"],
  ["document:closed", "doc-b"],
];

beforeEach(() => {
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  // CTRL_ROOM outlives the registry reset, and the observer seeds itself from
  // it, so publish the now-empty tab list before attaching.
  broadcastOpenDocs();
  useTrial(1);
  attachCtrlObservers();
});

afterEach(() => {
  setCtrlMode(null);
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

afterAll(() => {
  if (savedAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = savedAppDataDir;
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("document lifecycle events through the real registry (#2069)", () => {
  it("reach an internal subscriber and, in Tandem, an external one", () => {
    setCtrlMode("tandem");
    expect(aiRefusal(), "a fresh trial admits").toBeNull();
    const internal = collect("internal");
    const external = collect("external");

    tabSession();

    const shape = (events: TandemEvent[]) => events.map((e) => [e.type, e.documentId]);
    // The order of opened/switched inside one broadcast is the observer's
    // (activeDocumentId is checked first); compare as sets per pair.
    expect(shape(internal.lifecycle()).sort()).toEqual([...EXPECTED].sort());
    expect(shape(external.lifecycle()).sort()).toEqual([...EXPECTED].sort());
    unsubscribe(internal.cb);
    unsubscribe(external.cb);
  });

  it("are withheld from an external subscriber in Solo, and still reach the internal one", () => {
    setCtrlMode("solo");
    const internal = collect("internal");
    const external = collect("external");

    tabSession();

    expect(internal.lifecycle()).toHaveLength(EXPECTED.length);
    expect(external.lifecycle()).toEqual([]);
    // Nor are they replayed to a consumer that reconnects after switching to
    // Tandem: replay filters by the mode NOW, so a Solo-span lifecycle event
    // must be held by its push-time verdict instead.
    setCtrlMode("tandem");
    expect(replaySince("no-such-id").filter((e) => e.type.startsWith("document:"))).toEqual([]);
    unsubscribe(internal.cb);
    unsubscribe(external.cb);
  });

  it("are refused to an external subscriber under a licence refusal", () => {
    setCtrlMode("tandem");
    useTrial(30);
    expect(aiRefusal(), "an expired trial refuses").not.toBeNull();
    const internal = collect("internal");
    const external = collect("external");

    tabSession();

    expect(external.lifecycle()).toEqual([]);
    expect(internal.lifecycle().length).toBeGreaterThan(0);
    unsubscribe(internal.cb);
    unsubscribe(external.cb);
  });

  it("are never wake-worthy or start-worthy", () => {
    setCtrlMode("tandem");
    const internal = collect("internal");
    tabSession();
    const events = internal.lifecycle();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(isWakeWorthy(e), e.type).toBe(false);
      expect(isStartWorthy(e), e.type).toBe(false);
    }
    unsubscribe(internal.cb);
  });

  it("a content reload's unchanged re-broadcast emits nothing", () => {
    setCtrlMode("tandem");
    openDocument(doc("doc-a"));
    const internal = collect("internal");
    broadcastOpenDocs();
    expect(internal.lifecycle()).toEqual([]);
    unsubscribe(internal.cb);
  });
});
