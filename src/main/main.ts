import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';

// Set LV_DEBUG_PORT to attach a DevTools client (used by scripts/smoke.mjs to
// assert the window really rendered — a live process proves nothing on its own).
if (process.env.LV_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.LV_DEBUG_PORT);
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Surface renderer failures in the terminal. Without this a blank or broken
  // window looks identical to a healthy one from outside the app.
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[renderer] loaded');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason);
  });
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error('Failed to start:', error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
