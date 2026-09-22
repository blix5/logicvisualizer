// All ipcMain handlers. Handlers never throw across the boundary — they return
// { error } so the renderer always has something to show.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';

import { CHANNELS, type AudioFileBytes, type BounceFile, type RecentPreview, type Result } from '../shared/ipc';
import type { ProjectModel } from '../shared/model';
import { buildProjectModel } from './project/buildProject';
import { resolveLogicPaths } from './logic/logicPaths';

const BOUNCE_EXTENSIONS = ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'caf', 'flac'];

function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * The bundle of the project last loaded successfully. `audio:read` is confined to
 * it: unlike bounce:read, whose path comes from the native picker, its paths come
 * from bytes parsed out of the project, so it must not be able to read anything
 * else on disk.
 */
let openProjectRoot: string | null = null;

/**
 * Where the project picker opens: Logic's own default save location when it
 * exists, else the Music folder. Passed on every open so macOS's memory of the
 * last-used folder does not take over.
 */
function logicProjectsFolder(): string {
  const music = path.join(os.homedir(), 'Music');
  const logic = path.join(music, 'Logic');
  return fs.existsSync(logic) ? logic : music;
}

// Saved bounces live in app storage, one copy per project, so a project's
// mixdown comes back on reopen even if the original file is moved or deleted.
// An index maps the project's bundle path to the stored file's basename.
type BounceIndex = Record<string, { file: string; name: string; savedAt: number }>;

function bouncesDir(): string {
  return path.join(app.getPath('userData'), 'bounces');
}
function bounceIndexPath(): string {
  return path.join(bouncesDir(), 'index.json');
}
function readBounceIndex(): BounceIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(bounceIndexPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as BounceIndex) : {};
  } catch {
    return {};
  }
}
function writeBounceIndex(index: BounceIndex): void {
  fs.mkdirSync(bouncesDir(), { recursive: true });
  fs.writeFileSync(bounceIndexPath(), JSON.stringify(index, null, 2));
}
function bounceKey(projectPath: string): string {
  return crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 16);
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.projectPick, async () => {
    const window = getWindow();
    // openFile + openDirectory together is what makes macOS package bundles
    // like .logicx selectable rather than navigable-into.
    const options: Electron.OpenDialogOptions = {
      defaultPath: logicProjectsFolder(),
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'Logic Pro projects', extensions: ['logicx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const response = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return response.canceled ? null : response.filePaths[0] ?? null;
  });

  ipcMain.handle(CHANNELS.projectLoad, async (_event, selectionPath: string) => {
    try {
      const model: ProjectModel = buildProjectModel(selectionPath);
      openProjectRoot = model.projectPath;
      return model;
    } catch (error) {
      return failure(error);
    }
  });

  // A downscaled thumbnail for a recent project, read from WindowImage.jpg inside
  // the bundle. resolveLogicPaths validates the path is a real .logicx and keeps
  // the read confined to it. Never throws across the boundary: a project that has
  // moved or has no window image comes back with exists/dataUrl set accordingly.
  ipcMain.handle(CHANNELS.projectPreview, async (_event, projectPath: string): Promise<RecentPreview> => {
    // A saved bounce is tracked independently of the bundle, so a moved project
    // can still report one (and offer to clear it).
    const hasBounce = !!readBounceIndex()[projectPath];
    try {
      const paths = resolveLogicPaths(projectPath);
      if (!paths.projectDataPath) return { exists: false, dataUrl: null, hasBounce };
      if (!paths.windowImagePath) return { exists: true, dataUrl: null, hasBounce };
      try {
        const raw = await fs.promises.readFile(paths.windowImagePath);
        const thumb = nativeImage.createFromBuffer(raw).resize({ width: 480, quality: 'good' });
        const dataUrl = `data:image/jpeg;base64,${thumb.toJPEG(72).toString('base64')}`;
        return { exists: true, dataUrl, hasBounce };
      } catch {
        // The bundle is fine; only the image could not be read or decoded.
        return { exists: true, dataUrl: null, hasBounce };
      }
    } catch {
      // Not a resolvable .logicx anymore (moved, deleted, or never valid).
      return { exists: false, dataUrl: null, hasBounce };
    }
  });

  ipcMain.handle(CHANNELS.bouncePick, async () => {
    const window = getWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: BOUNCE_EXTENSIONS }],
    };
    const response = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return response.canceled ? null : response.filePaths[0] ?? null;
  });

  ipcMain.handle(CHANNELS.bounceRead, async (_event, filePath: string) => {
    try {
      const data = fs.readFileSync(filePath);
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const bounce: BounceFile = { path: filePath, name: path.basename(filePath), bytes };
      return bounce;
    } catch (error) {
      return failure(error);
    }
  });

  // Copy the picked bounce into app storage under a project-derived name,
  // replacing any bounce previously saved for that project.
  ipcMain.handle(CHANNELS.bounceSave, async (_event, projectPath: string, sourcePath: string) => {
    try {
      fs.mkdirSync(bouncesDir(), { recursive: true });
      const storedName = `${bounceKey(projectPath)}${path.extname(sourcePath) || '.wav'}`;
      await fs.promises.copyFile(sourcePath, path.join(bouncesDir(), storedName));
      const index = readBounceIndex();
      const previous = index[projectPath];
      // A new bounce with a different extension leaves the old file orphaned.
      if (previous && previous.file !== storedName) {
        try { await fs.promises.unlink(path.join(bouncesDir(), previous.file)); } catch { /* already gone */ }
      }
      index[projectPath] = { file: storedName, name: path.basename(sourcePath), savedAt: Date.now() };
      writeBounceIndex(index);
      return { name: path.basename(sourcePath) };
    } catch (error) {
      return failure(error);
    }
  });

  // The bounce saved for a project, read back from app storage. Returns null
  // (not a failure) when the project has no saved bounce, and forgets an entry
  // whose stored file has since disappeared.
  ipcMain.handle(CHANNELS.bounceSaved, async (_event, projectPath: string): Promise<Result<BounceFile | null>> => {
    try {
      const index = readBounceIndex();
      const entry = index[projectPath];
      if (!entry) return null;
      const stored = path.join(bouncesDir(), entry.file);
      let data: Buffer;
      try {
        data = await fs.promises.readFile(stored);
      } catch {
        delete index[projectPath];
        try { writeBounceIndex(index); } catch { /* best effort */ }
        return null;
      }
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const bounce: BounceFile = { path: stored, name: entry.name, bytes };
      return bounce;
    } catch (error) {
      return failure(error);
    }
  });

  // Delete a project's saved bounce and forget its index entry.
  ipcMain.handle(CHANNELS.bounceClear, async (_event, projectPath: string) => {
    try {
      const index = readBounceIndex();
      const entry = index[projectPath];
      if (!entry) return { cleared: false };
      try { await fs.promises.unlink(path.join(bouncesDir(), entry.file)); } catch { /* already gone */ }
      delete index[projectPath];
      writeBounceIndex(index);
      return { cleared: true };
    } catch (error) {
      return failure(error);
    }
  });

  // Asynchronous, unlike bounce:read. This one runs unattended for every audio
  // file in a project; reading them synchronously would freeze the window.
  ipcMain.handle(CHANNELS.audioRead, async (_event, filePath: string) => {
    try {
      if (!openProjectRoot) throw new Error('No project is open.');
      const root = await fs.promises.realpath(openProjectRoot);
      const resolved = await fs.promises.realpath(filePath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Refusing to read outside the open project: ${filePath}`);
      }
      const data = await fs.promises.readFile(resolved);
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const file: AudioFileBytes = { path: resolved, bytes };
      return file;
    } catch (error) {
      return failure(error);
    }
  });
}
