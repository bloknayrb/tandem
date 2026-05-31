import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Isolate session + annotation dirs in unique temp directories. The session
// dir is provided via the platform mock (hoisted — no module-level refs); the
// annotation dir is driven by TANDEM_APP_DATA_DIR set in beforeAll.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...mod,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-session-meta-${cryptoMod.randomUUID()}`),
  };
});

import { SESSION_DIR as TMP_SESSION_DIR } from "../../src/server/platform";

const TMP_APP_DATA = path.join(
  os.tmpdir(),
  `tandem-test-session-meta-appdata-${crypto.randomUUID()}`,
);

import { docHash } from "../../src/server/annotations/doc-hash";
import { getAnnotationsDir } from "../../src/server/annotations/store";
import {
  clearAllSessions,
  listSessionsMetadata,
  saveSession,
} from "../../src/server/session/manager";

function makeDoc(): Y.Doc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("hello")]);
  frag.insert(0, [p]);
  return doc;
}

async function writeEnvelope(filePath: string, annotationCount: number): Promise<void> {
  const hash = docHash(filePath);
  const annotations = Array.from({ length: annotationCount }, (_, i) => ({
    id: `ann_${i}`,
    author: "claude",
    type: "comment",
    range: { from: 0, to: 1 },
    content: "x",
    status: "pending",
    timestamp: Date.now(),
    rev: 1,
  }));
  const envelope = {
    schemaVersion: 1,
    docHash: hash,
    meta: { filePath, lastUpdated: Date.now() },
    annotations,
    replies: [],
    tombstones: [],
  };
  const dir = getAnnotationsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify(envelope), "utf-8");
}

describe("session metadata (#103)", () => {
  beforeAll(() => {
    process.env.TANDEM_APP_DATA_DIR = TMP_APP_DATA;
  });

  afterAll(async () => {
    delete process.env.TANDEM_APP_DATA_DIR;
    await fs.rm(TMP_SESSION_DIR, { recursive: true, force: true });
    await fs.rm(TMP_APP_DATA, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fs.rm(TMP_SESSION_DIR, { recursive: true, force: true });
    await fs.rm(getAnnotationsDir(), { recursive: true, force: true });
    await fs.mkdir(TMP_SESSION_DIR, { recursive: true });
  });

  const fileA = path.resolve("tests/fixtures/meta-a.md");
  const fileB = path.resolve("tests/fixtures/meta-b.md");

  it("lists sessions with annotation counts", async () => {
    await saveSession(fileA, "md", makeDoc());
    await saveSession(fileB, "md", makeDoc());
    await writeEnvelope(fileA, 3);
    // fileB has no envelope → count should be 0

    const meta = await listSessionsMetadata();
    const byPath = new Map(meta.map((m) => [m.filePath, m]));

    expect(byPath.get(fileA)?.annotationCount).toBe(3);
    expect(byPath.get(fileB)?.annotationCount).toBe(0);
    expect(byPath.get(fileA)?.lastAccessed).toBeGreaterThan(0);
  });

  it("returns 0 annotations for a corrupt envelope", async () => {
    await saveSession(fileA, "md", makeDoc());
    const dir = getAnnotationsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${docHash(fileA)}.json`), "{ not valid json", "utf-8");

    const meta = await listSessionsMetadata();
    expect(meta.find((m) => m.filePath === fileA)?.annotationCount).toBe(0);
  });

  it("clears all sessions and reports the deleted count", async () => {
    await saveSession(fileA, "md", makeDoc());
    await saveSession(fileB, "md", makeDoc());

    const cleared = await clearAllSessions();
    expect(cleared).toBe(2);

    const meta = await listSessionsMetadata();
    expect(meta).toHaveLength(0);
  });
});
