/**
 * #2266 — session files hold a document's full `ydocState` (and the ctrl file
 * holds chat history), so the session store is owner-only: `sessions/` at
 * 0700, every file it writes at 0600. Pre-seeded the way an older build left
 * it — a 0755 directory holding 0644 files — to prove an existing install is
 * tightened, not only a fresh one.
 *
 * What it deliberately does NOT promise is pinned too: a file the store never
 * rewrites (a quarantined `*.corrupt.*`) keeps its mode, because nothing
 * chmods a file by path; the 0700 directory is what protects it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock(import("../../../src/server/platform"), async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../src/server/platform")>();
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  return {
    ...mod,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-session-modes-${cryptoMod.randomUUID()}`),
  };
});

import { SESSION_DIR } from "../../../src/server/platform";
import {
  ensureSessionDirPrivate,
  saveCtrlSession,
  saveSession,
  sessionKey,
} from "../../../src/server/session/manager";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../../src/shared/constants.js";
import { modeOf } from "../../helpers/file-mode.js";

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  fragment.insert(0, [p]);
  p.insert(0, [new Y.XmlText(text)]);
  return doc;
}

describe.skipIf(process.platform === "win32")("session store modes (#2266)", () => {
  let savedUmask: number;

  beforeEach(async () => {
    savedUmask = process.umask(0o022);
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    process.umask(savedUmask);
  });

  afterAll(async () => {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  // Must stay the FIRST save in this file: `saveSession` hardens the directory
  // once per run (`sessionDirReady`), and this is the case that observes it.
  it("tightens a pre-existing 0755 sessions dir and rewrites a 0644 session at 0600", async () => {
    const filePath = path.join(path.dirname(SESSION_DIR), "private-notes.md");
    const sessionFile = path.join(SESSION_DIR, `${sessionKey(filePath)}.json`);
    const quarantined = path.join(SESSION_DIR, "old.json.corrupt.1700000000000");

    await fs.mkdir(SESSION_DIR, { mode: 0o755 });
    await fs.chmod(SESSION_DIR, 0o755);
    await fs.writeFile(sessionFile, "{}");
    await fs.chmod(sessionFile, 0o644);
    await fs.writeFile(quarantined, "not json");
    await fs.chmod(quarantined, 0o644);

    await saveSession(filePath, "md", docWithText("secret prose"));

    expect(modeOf(SESSION_DIR)).toBe(0o700);
    expect(modeOf(sessionFile)).toBe(0o600);
    // Never rewritten, so its mode is untouched — the directory covers it.
    expect(modeOf(quarantined)).toBe(0o644);
  });

  it("writes the ctrl (chat history) file at 0600", async () => {
    const ctrlFile = path.join(SESSION_DIR, `${CTRL_ROOM}.json`);
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.writeFile(ctrlFile, "{}");
    await fs.chmod(ctrlFile, 0o644);

    const ctrl = new Y.Doc();
    ctrl.getMap(Y_MAP_CHAT);
    await saveCtrlSession(ctrl);

    expect(modeOf(ctrlFile)).toBe(0o600);
  });

  it("the boot hook tightens an existing sessions dir without a write", async () => {
    await fs.mkdir(SESSION_DIR, { mode: 0o755 });
    await fs.chmod(SESSION_DIR, 0o755);

    await ensureSessionDirPrivate();

    expect(modeOf(SESSION_DIR)).toBe(0o700);
  });

  it("the boot hook creates a missing sessions dir at 0700", async () => {
    await ensureSessionDirPrivate();
    expect(modeOf(SESSION_DIR)).toBe(0o700);
  });
});
