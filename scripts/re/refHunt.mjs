// Finds the audio region present in `after` but not `before`, then locates every
// reference to its chunk id in each file. Whatever structure gained a reference
// is the structure that places regions on the timeline.
//   node scripts/re/refHunt.mjs <before> <after>
import fs from 'node:fs';

const TAGS = ['gRuA', 'lFuA', 'LFUA', 'karT', 'qSvE', 'qeSM', 'OCuA', 'UCuA', 'ivnE', 'qSxT', 'gnoS'];

function scanRegions(buf) {
  const out = [];
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf('gRuA', from, 'latin1');
    if (at < 0) break;
    from = at + 1;
    if (at + 114 > buf.length) continue;
    const nameLength = buf.readUInt16LE(at + 110);
    if (nameLength <= 0 || nameLength > 200 || at + 112 + nameLength > buf.length) continue;
    out.push({
      at,
      name: buf.toString('latin1', at + 112, at + 112 + nameLength),
      id16: buf.readUInt16LE(at + 4),
      id32: buf.readUInt32LE(at + 4),
      fileOid: buf.readUInt32LE(at + 10),
    });
  }
  return out;
}

function tagIndex(buf) {
  const all = [];
  for (const tag of TAGS) {
    let from = 0;
    while (from < buf.length) {
      const at = buf.indexOf(tag, from, 'latin1');
      if (at < 0) break;
      all.push({ tag, at });
      from = at + 1;
    }
  }
  return all.sort((x, y) => x.at - y.at);
}

function containing(index, offset) {
  let low = 0;
  let high = index.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index[mid].at <= offset) { found = index[mid]; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

/** Every offset where `value` appears as a u32 LE. */
function findU32(buf, value) {
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(value, 0);
  const out = [];
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + 1;
  }
  return out;
}

const before = fs.readFileSync(process.argv[2]);
const after = fs.readFileSync(process.argv[3]);
const beforeRegions = scanRegions(before);
const afterRegions = scanRegions(after);
const beforeNames = new Set(beforeRegions.map((r) => r.name));
const added = afterRegions.filter((r) => !beforeNames.has(r.name));

console.log(`before ${beforeRegions.length} regions, after ${afterRegions.length}`);
console.log(`added: ${added.map((r) => `"${r.name}" (id16 ${r.id16}, id32 ${r.id32})`).join(', ')}\n`);

const beforeIndex = tagIndex(before);
const afterIndex = tagIndex(after);

for (const region of added) {
  console.log(`references to id32 ${region.id32} ("${region.name}"):`);
  const tally = new Map();
  for (const at of findU32(after, region.id32)) {
    const chunk = containing(afterIndex, at);
    const key = `${chunk?.tag ?? '(none)'}+${chunk ? at - chunk.at : at}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const beforeTally = new Map();
  for (const at of findU32(before, region.id32)) {
    const chunk = containing(beforeIndex, at);
    const key = `${chunk?.tag ?? '(none)'}+${chunk ? at - chunk.at : at}`;
    beforeTally.set(key, (beforeTally.get(key) ?? 0) + 1);
  }
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  for (const [key, count] of rows) {
    const was = beforeTally.get(key) ?? 0;
    console.log(`   ${key.padEnd(18)} after ${String(count).padStart(3)}  before ${String(was).padStart(3)}${count > was ? '   <-- NEW' : ''}`);
  }
  console.log();
}
