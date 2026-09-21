// All ipcMain handlers. Handlers never throw across the boundary — they return
// { error } so the renderer always has something to show.
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';

import { CHANNELS, type AudioFileBytes, type BounceFile } from '../shared/ipc';
import type { ProjectModel } from '../shared/model';
import { buildProjectModel } from './project/buildProject';

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

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.projectPick, async () => {
    const window = getWindow();
    // openFile + openDirectory together is what makes macOS package bundles
    // like .logicx selectable rather than navigable-into.
    const options: Electron.OpenDialogOptions = {
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
