// A small, frameless, always-on-top overlay shown while an automatic bounce
// runs. It floats above Logic Pro (which is frontmost during the bounce), can't
// be closed by the user, and offers only a Cancel button. Progress is
// indeterminate — Logic doesn't expose a render percentage — so the bar just
// animates while the render proceeds.
//
// The window loads trusted inline HTML, so it runs with nodeIntegration on and
// contextIsolation off (no separate preload build entry needed); it talks to the
// main process over a private channel scoped to its own webContents.
import { BrowserWindow, ipcMain } from 'electron';

const CANCEL_CHANNEL = 'lv:bounce-progress:cancel';
const STATUS_CHANNEL = 'lv:bounce-progress:status';

export type BounceProgressHandle = {
  /** Update the status line shown under the title. */
  setStatus(message: string): void;
  /** Allow and perform the close, tearing down the window and its listener. */
  finish(): void;
};

function pageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; }
    body {
      font: 13px -apple-system, system-ui, sans-serif;
      background: #1c1c1e; color: #f2f2f7;
      display: flex; align-items: center; justify-content: center;
      -webkit-user-select: none; user-select: none;
      border-radius: 12px; overflow: hidden;
      -webkit-app-region: drag;
    }
    .card { width: 100%; box-sizing: border-box; padding: 18px 20px; }
    .title { font-weight: 600; font-size: 14px; margin: 0 0 4px; }
    .status { color: #a1a1a6; margin: 0 0 14px; min-height: 16px; }
    .track { height: 6px; border-radius: 3px; background: #3a3a3c; overflow: hidden; }
    .bar { height: 100%; width: 40%; border-radius: 3px;
      background: linear-gradient(90deg, #0a84ff, #64d2ff);
      animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide {
      0% { margin-left: -40%; } 100% { margin-left: 100%; }
    }
    .row { display: flex; justify-content: flex-end; margin-top: 16px; }
    button {
      -webkit-app-region: no-drag;
      font: inherit; color: #f2f2f7; background: #3a3a3c;
      border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer;
    }
    button:hover { background: #48484a; }
    button:disabled { opacity: 0.5; cursor: default; }
  </style></head><body><div class="card">
    <p class="title">Bouncing in Logic Pro</p>
    <p class="status" id="status">Preparing…</p>
    <div class="track"><div class="bar"></div></div>
    <div class="row"><button id="cancel">Cancel</button></div>
  </div><script>
    const { ipcRenderer } = require('electron');
    const statusEl = document.getElementById('status');
    const cancelEl = document.getElementById('cancel');
    ipcRenderer.on('${STATUS_CHANNEL}', (_e, msg) => { statusEl.textContent = msg; });
    cancelEl.addEventListener('click', () => {
      cancelEl.disabled = true;
      statusEl.textContent = 'Cancelling…';
      ipcRenderer.send('${CANCEL_CHANNEL}');
    });
  </script></body></html>`;
}

/**
 * Shows the overlay and returns a handle. `onCancel` fires when the user clicks
 * Cancel (cooperative — the caller decides how to stop).
 */
export function showBounceProgress(parent: BrowserWindow | null, onCancel: () => void): BounceProgressHandle {
  const win = new BrowserWindow({
    width: 380,
    height: 150,
    frame: false,
    transparent: false,
    backgroundColor: '#1c1c1e',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // Float above everything, including Logic Pro when it is activated, and on
  // whichever Space the user is looking at.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Non-closable: swallow user close attempts until finish() opts in.
  let allowClose = false;
  win.on('close', (event) => { if (!allowClose) event.preventDefault(); });

  const cancelListener = (event: Electron.IpcMainEvent): void => {
    if (event.sender === win.webContents) onCancel();
  };
  ipcMain.on(CANCEL_CHANNEL, cancelListener);

  win.once('ready-to-show', () => {
    if (parent && !parent.isDestroyed()) {
      const b = parent.getBounds();
      win.setPosition(
        Math.round(b.x + (b.width - 380) / 2),
        Math.round(b.y + Math.max(40, b.height * 0.15)),
      );
    }
    win.show();
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml())}`);

  return {
    setStatus(message: string): void {
      if (!win.isDestroyed()) win.webContents.send(STATUS_CHANNEL, message);
    },
    finish(): void {
      ipcMain.removeListener(CANCEL_CHANNEL, cancelListener);
      allowClose = true;
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
