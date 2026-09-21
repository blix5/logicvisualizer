// Resolves the interesting files inside a `.logicx` bundle. Extracted from
// Texture's logicProject.ts (resolveLogicPaths / resolveLogicWindowImagePath).
//
// Unlike Texture we deliberately ignore Autosave/*.songData: it is a delta that
// frequently lacks the ivnE track-name strips, so a visualizer reading it would
// silently render unnamed tracks. Reload reads ProjectData or reports an error.
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DATA_FILE_NAMES = ['Project Data', 'ProjectData'];

export type LogicPaths = {
  projectPath: string;
  projectName: string;
  alternativePath: string;
  alternativeId: string;
  projectDataPath: string | null;
  metadataPath: string | null;
  windowImagePath: string | null;
  mediaPath: string | null;
};

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function findLogicProjectAncestor(selectionPath: string): string | null {
  let current = path.resolve(selectionPath);
  for (let depth = 0; depth < 12; depth += 1) {
    if (current.toLowerCase().endsWith('.logicx')) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findProjectDataFile(alternativePath: string): string | null {
  for (const name of PROJECT_DATA_FILE_NAMES) {
    const candidate = path.join(alternativePath, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function listAlternatives(projectPath: string): string[] {
  const root = path.join(projectPath, 'Alternatives');
  if (!isDirectory(root)) return [];
  return fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter(isDirectory);
}

/** Prefer Alternatives/000; otherwise the alternative with the newest ProjectData. */
function pickAlternative(projectPath: string): string | null {
  const alternatives = listAlternatives(projectPath);
  if (alternatives.length === 0) return null;
  const preferred = alternatives.find((p) => path.basename(p) === '000');
  if (preferred && findProjectDataFile(preferred)) return preferred;
  let best: { p: string; mtime: number } | null = null;
  for (const p of alternatives) {
    const data = findProjectDataFile(p);
    if (!data) continue;
    const mtime = fs.statSync(data).mtimeMs;
    if (!best || mtime > best.mtime) best = { p, mtime };
  }
  return best?.p ?? preferred ?? alternatives[0] ?? null;
}

export function resolveLogicPaths(selectionPath: string): LogicPaths {
  const projectPath = findLogicProjectAncestor(selectionPath);
  if (!projectPath) {
    throw new Error(`Not inside a .logicx bundle: ${selectionPath}`);
  }
  const alternativePath = pickAlternative(projectPath);
  if (!alternativePath) {
    throw new Error(`No Alternatives folder in ${path.basename(projectPath)}`);
  }
  const windowImage = path.join(alternativePath, 'WindowImage.jpg');
  const metadata = path.join(alternativePath, 'MetaData.plist');
  const media = path.join(projectPath, 'Media');
  return {
    projectPath,
    projectName: path.basename(projectPath).replace(/\.logicx$/i, ''),
    alternativePath,
    alternativeId: path.basename(alternativePath),
    projectDataPath: findProjectDataFile(alternativePath),
    metadataPath: isFile(metadata) ? metadata : null,
    windowImagePath: isFile(windowImage) ? windowImage : null,
    mediaPath: isDirectory(media) ? media : null,
  };
}
