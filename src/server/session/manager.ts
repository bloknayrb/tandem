import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import type { SessionData } from "../../shared/types.js";
import { SESSION_DIR } from "../platform.js";

import { SESSION_MAX_AGE, CTRL_ROOM, Y_MAP_CHAT } from "../../shared/constants.js";
import { MCP_ORIGIN } from "../events/queue.js";

const AUTO_SAVE_INTERVAL = 60 * 1000; // 60 seconds
let sessionDirReady = false;

/** Generate a session key from a file path */
export function sessionKey(filePath: string): string {
  return encodeURIComponent(filePath.replace(/\\/g, "/"));
}

/** Save Y.Doc state + metadata as a session file */
export async function saveSession(filePath: string, format: string, doc: Y.Doc): Promise<void> {
  const key = sessionKey(filePath);
  let sourceFileMtime = 0;
  // Upload paths have no disk file — skip stat
  if (!filePath.startsWith("upload://")) {
    try {
      const stat = await fs.stat(filePath);
      sourceFileMtime = stat.mtimeMs;
    } catch {
      // File may not exist yet (new doc)
    }
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");

  const data: SessionData = {
    filePath,
    format,
    ydocState,
    sourceFileMtime,
    lastAccessed: Date.now(),
  };

  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  const tmpPath = `${sessionPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data), "utf-8");
  try {
    await fs.rename(tmpPath, sessionPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Load a session file if it exists */
export async function loadSession(filePath: string): Promise<SessionData | null> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    return JSON.parse(content) as SessionData;
  } catch {
    return null;
  }
}

/** Restore a Y.Doc from a session's base64-encoded state */
export function restoreYDoc(doc: Y.Doc, session: SessionData): void {
  const state = Buffer.from(session.ydocState, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
}

/** Check if the source file has changed since the session was saved */
export async function sourceFileChanged(session: SessionData): Promise<boolean> {
  // Uploaded files have no disk path — session is the only truth
  if (session.filePath.startsWith("upload://")) return false;
  try {
    const stat = await fs.stat(session.filePath);
    return stat.mtimeMs !== session.sourceFileMtime;
  } catch {
    return true; // File doesn't exist — treat as changed
  }
}

/** Delete a session file */
export async function deleteSession(filePath: string): Promise<void> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    await fs.unlink(sessionPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[Tandem] deleteSession: failed to delete ${sessionPath}:`, err);
    }
  }
}

// --- CTRL_ROOM persistence (chat history) ---

const CTRL_SESSION_KEY = CTRL_ROOM;

/** Save the CTRL_ROOM Y.Doc (chat history) */
export async function saveCtrlSession(doc: Y.Doc): Promise<void> {
  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }

  // Prune chat to newest 200 messages before saving
  const chatMap = doc.getMap(Y_MAP_CHAT);
  const entries: Array<{ id: string; timestamp: number }> = [];
  chatMap.forEach((value, key) => {
    const msg = value as { timestamp: number };
    entries.push({ id: key, timestamp: msg.timestamp });
  });
  if (entries.length > 200) {
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = entries.slice(0, entries.length - 200);
    doc.transact(() => {
      for (const entry of toDelete) {
        chatMap.delete(entry.id);
      }
    }, MCP_ORIGIN);
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");

  const data = { ydocState, lastAccessed: Date.now() };
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  const tmpPath = `${sessionPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data), "utf-8");
  try {
    await fs.rename(tmpPath, sessionPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Load the CTRL_ROOM session if it exists */
export async function loadCtrlSession(): Promise<string | null> {
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content);
    return data.ydocState ?? null;
  } catch {
    return null;
  }
}

/** Restore a CTRL_ROOM Y.Doc from base64 state */
export function restoreCtrlDoc(doc: Y.Doc, base64State: string): void {
  const state = Buffer.from(base64State, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
}

/** Delete sessions older than 30 days */
export async function cleanupSessions(): Promise<number> {
  let cleaned = 0;
  try {
    const files = await fs.readdir(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SESSION_MAX_AGE) {
        await fs.unlink(filePath);
        cleaned++;
      }
    }
  } catch {
    // Session dir doesn't exist yet
  }
  return cleaned;
}

// --- Auto-save ---

let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let autoSaveCallback: (() => Promise<void>) | null = null;

/** Check if auto-save is currently running */
export function isAutoSaveRunning(): boolean {
  return autoSaveTimer !== null;
}

/** Start auto-saving every 60 seconds. Pass a callback that saves the current session. */
export function startAutoSave(callback: () => Promise<void>): void {
  stopAutoSave();
  autoSaveCallback = callback;
  autoSaveTimer = setInterval(async () => {
    try {
      await autoSaveCallback?.();
    } catch (err) {
      console.error("[Tandem] Auto-save failed:", err);
    }
  }, AUTO_SAVE_INTERVAL);
}

/** Stop auto-save timer */
export function stopAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  autoSaveCallback = null;
}
