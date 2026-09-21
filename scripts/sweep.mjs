// Parse every .logicx under a folder and print a one-line summary each.
//   node scripts/sweep.mjs [dir]        (default ~/Music/Logic)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTs } from './run-ts.mjs';

const dir = process.argv[2] ?? path.join(os.homedir(), 'Music', 'Logic');
const projects = fs.readdirSync(dir).filter((n) => n.endsWith('.logicx')).sort();

await runTs('src/main/project/buildProject.ts', ({ buildProjectModel }) => {
  let failures = 0;
  const rows = [];
  console.log(`${'project'.padEnd(34)} ${'trk'.padStart(4)} ${'midi'.padStart(5)} ${'notes'.padStart(6)} ${'aud'.padStart(4)} ${'files'.padStart(5)} ${'tmpo'.padStart(4)} ${'mark'.padStart(4)} ${'ms'.padStart(5)}`);
  for (const name of projects) {
    const started = Date.now();
    try {
      const m = buildProjectModel(path.join(dir, name));
      const midi = m.regions.filter((r) => r.kind === 'midi');
      const audio = m.regions.filter((r) => r.kind === 'audio');
      const notes = midi.reduce((n, r) => n + r.noteCount, 0);
      rows.push({ name, warnings: m.warnings });
      console.log(
        `${name.replace('.logicx', '').slice(0, 34).padEnd(34)} ${String(m.tracks.length).padStart(4)} ${String(midi.length).padStart(5)} ${String(notes).padStart(6)} ${String(audio.length).padStart(4)} ${String(m.audioFiles.length).padStart(5)} ${String(m.tempoEvents.length).padStart(4)} ${String(m.markers.length).padStart(4)} ${String(Date.now() - started).padStart(5)}`,
      );
    } catch (error) {
      failures += 1;
      console.log(`${name.replace('.logicx', '').slice(0, 34).padEnd(34)} FAILED: ${error.message}`);
    }
  }
  const warned = rows.filter((r) => r.warnings.length > 0).length;
  console.log(`\n${projects.length} projects · ${failures} failures · ${warned} with warnings`);
  if (failures > 0) process.exitCode = 1;
});
