import fs from 'fs/promises';
import path from 'path';

export async function loadPlaintext(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function savePlaintext(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}`);
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}
