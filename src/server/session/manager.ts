import fs from 'fs/promises';
import path from 'path';
import type { SessionData } from '../../shared/types.js';

// Session storage in %LOCALAPPDATA%\tandem\sessions\ (not project dir, avoids OneDrive sync)
const SESSION_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'tandem', 'sessions')
  : path.join('.tandem', 'sessions');

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function saveSession(key: string, data: SessionData): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const filePath = path.join(SESSION_DIR, `${encodeURIComponent(key)}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function loadSession(key: string): Promise<SessionData | null> {
  const filePath = path.join(SESSION_DIR, `${encodeURIComponent(key)}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SessionData;
  } catch {
    return null;
  }
}

export async function cleanupSessions(): Promise<void> {
  try {
    const files = await fs.readdir(SESSION_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SESSION_MAX_AGE) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    // Session dir doesn't exist yet, nothing to clean
  }
}
