// Appearance storage: the background image, and the window colour the next
// launch should open with. Both live in app storage under appearance/. The
// image is picked and copied in one handler, so the renderer never hands main
// a path to copy from.
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from 'electron';

import { CHANNELS, type BackgroundImage, type Result } from '../shared/ipc';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

/** Past this the image is not worth holding in memory as a backdrop. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

type BackgroundIndex = { file: string; name: string } | null;
type WindowState = { background: string };

function appearanceDir(): string {
  return path.join(app.getPath('userData'), 'appearance');
}
function backgroundIndexPath(): string {
  return path.join(appearanceDir(), 'background.json');
}
function windowStatePath(): string {
  return path.join(appearanceDir(), 'window.json');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(appearanceDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

/** The window colour the last theme asked for, so a relaunch does not flash the default. */
export function savedWindowBackground(fallback: string): string {
  const state = readJson<WindowState>(windowStatePath());
  return state && /^#[0-9a-f]{6}$/i.test(state.background) ? state.background : fallback;
}

async function readBackground(): Promise<BackgroundImage | null> {
  const index = readJson<BackgroundIndex>(backgroundIndexPath());
  if (!index) return null;
  const stored = path.join(appearanceDir(), index.file);
  let data: Buffer;
  try {
    data = await fs.promises.readFile(stored);
  } catch {
    // The file went missing; forget it rather than failing every launch.
    try { fs.unlinkSync(backgroundIndexPath()); } catch { /* already gone */ }
    return null;
  }
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return { name: index.name, type: IMAGE_TYPES[path.extname(index.file).toLowerCase()] ?? 'image/png', bytes };
}

async function removeBackground(): Promise<boolean> {
  const index = readJson<BackgroundIndex>(backgroundIndexPath());
  if (!index) return false;
  try { await fs.promises.unlink(path.join(appearanceDir(), index.file)); } catch { /* already gone */ }
  try { await fs.promises.unlink(backgroundIndexPath()); } catch { /* already gone */ }
  return true;
}

export function registerAppearanceIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.appearanceChooseBackground, async (): Promise<Result<BackgroundImage | null>> => {
    try {
      const window = getWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES).map((ext) => ext.slice(1)) }],
      };
      const response = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const source = response.canceled ? null : response.filePaths[0] ?? null;
      if (!source) return null;
      const ext = path.extname(source).toLowerCase();
      if (!IMAGE_TYPES[ext]) throw new Error(`${path.basename(source)} is not a supported image.`);
      const { size } = await fs.promises.stat(source);
      if (size > MAX_IMAGE_BYTES) throw new Error(`${path.basename(source)} is too large (over 40 MB).`);

      await removeBackground();
      fs.mkdirSync(appearanceDir(), { recursive: true });
      // A fresh name per image, so nothing holding the old one sees it change.
      const file = `background-${Date.now()}${ext}`;
      await fs.promises.copyFile(source, path.join(appearanceDir(), file));
      writeJson(backgroundIndexPath(), { file, name: path.basename(source) } satisfies BackgroundIndex);
      return await readBackground();
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(CHANNELS.appearanceBackground, async (): Promise<Result<BackgroundImage | null>> => {
    try {
      return await readBackground();
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(CHANNELS.appearanceClearBackground, async () => {
    try {
      return { cleared: await removeBackground() };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(CHANNELS.appearanceSetWindow, (_event, background: string, scheme: 'dark' | 'light' | 'system') => {
    nativeTheme.themeSource = scheme === 'dark' || scheme === 'light' ? scheme : 'system';
    if (!/^#[0-9a-f]{6}$/i.test(background)) return;
    getWindow()?.setBackgroundColor(background);
    const saved = readJson<WindowState>(windowStatePath());
    if (saved?.background === background) return;
    try { writeJson(windowStatePath(), { background } satisfies WindowState); } catch { /* next launch uses the default */ }
  });
}
