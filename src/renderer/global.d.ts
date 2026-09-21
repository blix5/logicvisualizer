declare global {
  interface Window {
    lv: import('../shared/ipc').LvApi;
  }
}
export {};
