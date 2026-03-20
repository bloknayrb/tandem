import fs from 'fs/promises';
import path from 'path';
import * as Y from 'yjs';
import type { SessionData } from '../../shared/types.js';

// Session storage in %LOCALAPPDATA%\tandem\sessions\ (not project dir, avoids OneDrive sync)
const SESSION_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'tandem', 'sessions')
  : path.join('.tandem', 'sessions');

import { SESSION_MAX_AGE } from '../../shared/constants.js';

const AUTO_SAVE_INTERVAL = 60 * 1000; // 60 seconds
let sessionDirReady = false;

/** Generate a session key from a file path */
export function sessionKey(filePath: string): string {
  return encodeURIComponent(filePath.replace(/\\/g, '/'));
}

/** Save Y.Doc state + metadata as a session file */
export async function saveSession(
  filePath: string,
  format: string,
  doc: Y.Doc,
): Promise<void> {
  const key = sessionKey(filePath);
  let sourceFileMtime = 0;
  try {
    const stat = await fs.stat(filePath);
    sourceFileMtime = stat.mtimeMs;
  } catch {
    // File may not exist yet (new doc)
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString('base64');

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
  await fs.writeFile(sessionPath, JSON.stringify(data), 'utf-8');
}

/** Load a session file if it exists */
export async function loadSession(filePath: string): Promise<SessionData | null> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(content) as SessionData;
  } catch {
    return null;
  }
}

/** Restore a Y.Doc from a session's base64-encoded state */
export function restoreYDoc(doc: Y.Doc, session: SessionData): void {
  const state = Buffer.from(session.ydocState, 'base64');
  Y.applyUpdate(doc, new Uint8Array(state));
}

/** Check if the source file has changed since the session was saved */
export async function sourceFileChanged(session: SessionData): Promise<boolean> {
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
  } catch {
    // Already gone
  }
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

/** Start auto-saving every 60 seconds. Pass a callback that saves the current session. */
export function startAutoSave(callback: () => Promise<void>): void {
  stopAutoSave();
  autoSaveCallback = callback;
  autoSaveTimer = setInterval(async () => {
    try {
      await autoSaveCallback?.();
    } catch (err) {
      console.error('[Tandem] Auto-save failed:', err);
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
