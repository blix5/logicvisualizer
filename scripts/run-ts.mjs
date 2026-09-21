// Bundles a TypeScript entry with esbuild and runs it in node. Used by the dev
// CLIs so they can import the same parser modules the app uses.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function runTs(entry, run) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logicviz-'));
  const outFile = path.join(outDir, 'bundle.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: outFile,
    external: ['electron'],
    logLevel: 'error',
  });
  try {
    const mod = await import(pathToFileURL(outFile).href);
    await run(mod);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
