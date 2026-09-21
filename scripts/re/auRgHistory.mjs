// Walks a project's save history and reports how each audio region's decoded
// fields changed between consecutive saves. If a region visibly moved in Logic
// but no field here changed, the position is NOT in the AuRg record.
//   node scripts/re/auRgHistory.mjs <project.logicx>
import fs from 'node:fs';
import path from 'node:path';

function readRegions(file) {
  const buf = fs.readFileSync(file);
  const out = new Map();
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf('gRuA', from, 'latin1');
    if (at < 0) break;
    from = at + 1;
    if (at + 112 + 2 > buf.length) continue;
    const nameLength = buf.readUInt16LE(at + 110);
    if (nameLength <= 0 || nameLength > 200 || at + 112 + nameLength > buf.length) continue;
    const name = buf.toString('latin1', at + 112, at + 112 + nameLength);
    out.set(name, {
      fileOid: buf.readUInt32LE(at + 10),
      length: buf.readUInt32LE(at + 42),
      position: buf.readUInt32LE(at + 50),
      fileStart: buf.readUInt32LE(at + 58),
    });
  }
  return out;
}

const project = process.argv[2];
const backups = path.join(project, 'Alternatives/000/Project File Backups');
const slots = fs.readdirSync(backups)
  .map((slot) => ({ slot, file: path.join(backups, slot, 'ProjectData') }))
  .filter((entry) => fs.existsSync(entry.file))
  .map((entry) => ({ ...entry, mtime: fs.statSync(entry.file).mtimeMs }))
  .sort((x, y) => x.mtime - y.mtime);

console.log(`${path.basename(project)} — ${slots.length} saves in history\n`);
let previous = null;
for (const entry of slots) {
  const regions = readRegions(entry.file);
  if (previous) {
    const changes = [];
    for (const [name, now] of regions) {
      const was = previous.regions.get(name);
      if (!was) { changes.push(`  + ${name} (new)`); continue; }
      const diffs = [];
      for (const key of ['position', 'length', 'fileStart', 'fileOid']) {
        if (was[key] !== now[key]) diffs.push(`${key} ${was[key]} -> ${now[key]} (${now[key] - was[key] >= 0 ? '+' : ''}${now[key] - was[key]})`);
      }
      if (diffs.length) changes.push(`  ~ ${name}: ${diffs.join(', ')}`);
    }
    for (const name of previous.regions.keys()) {
      if (!regions.has(name)) changes.push(`  - ${name} (gone)`);
    }
    const header = `${previous.slot} -> ${entry.slot}  (${previous.regions.size} -> ${regions.size} regions)`;
    console.log(changes.length ? `${header}\n${changes.slice(0, 14).join('\n')}${changes.length > 14 ? `\n  ... ${changes.length - 14} more` : ''}\n` : `${header}  no field changes\n`);
  }
  previous = { slot: entry.slot, regions };
}
