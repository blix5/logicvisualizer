import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type LvApi } from '../shared/ipc';

const api: LvApi = {
  project: {
    pick: () => ipcRenderer.invoke(CHANNELS.projectPick),
    load: (selectionPath) => ipcRenderer.invoke(CHANNELS.projectLoad, selectionPath),
    preview: (projectPath) => ipcRenderer.invoke(CHANNELS.projectPreview, projectPath),
  },
  bounce: {
    pick: () => ipcRenderer.invoke(CHANNELS.bouncePick),
    read: (filePath) => ipcRenderer.invoke(CHANNELS.bounceRead, filePath),
    save: (projectPath, sourcePath) => ipcRenderer.invoke(CHANNELS.bounceSave, projectPath, sourcePath),
    saved: (projectPath) => ipcRenderer.invoke(CHANNELS.bounceSaved, projectPath),
    clear: (projectPath) => ipcRenderer.invoke(CHANNELS.bounceClear, projectPath),
  },
  audio: {
    read: (filePath) => ipcRenderer.invoke(CHANNELS.audioRead, filePath),
  },
};

contextBridge.exposeInMainWorld('lv', api);
