import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type LvApi } from '../shared/ipc';

const api: LvApi = {
  project: {
    pick: () => ipcRenderer.invoke(CHANNELS.projectPick),
    load: (selectionPath) => ipcRenderer.invoke(CHANNELS.projectLoad, selectionPath),
  },
  bounce: {
    pick: () => ipcRenderer.invoke(CHANNELS.bouncePick),
    read: (filePath) => ipcRenderer.invoke(CHANNELS.bounceRead, filePath),
  },
  audio: {
    read: (filePath) => ipcRenderer.invoke(CHANNELS.audioRead, filePath),
  },
};

contextBridge.exposeInMainWorld('lv', api);
