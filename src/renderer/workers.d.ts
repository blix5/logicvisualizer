// Vite's inline-worker import. `?worker&inline` builds the worker as a Blob URL,
// which is what makes it work in production: the packaged renderer is loaded with
// loadFile (see src/main/main.ts), and Chromium refuses to construct a worker from
// a plain URL on a file:// origin.
declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
