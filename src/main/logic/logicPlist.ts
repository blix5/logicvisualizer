import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function readPlistJson(plistPath: string): Record<string, unknown> | null {
  if (!isFile(plistPath)) {
    return null;
  }
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const output = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf-8',
    });
    const data = JSON.parse(output);
    return data && typeof data === 'object' ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
