import fs from 'fs/promises';
import path from 'path';

export async function loadFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function saveFile(filePath: string, content: string): Promise<void> {
  // Atomic save: write to temp, then rename
  const tempPath = path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}`);
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}
