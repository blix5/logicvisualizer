// Exact byte diff with resynchronisation. Makes NO assumptions about chunk
// structure: it walks both buffers, and on a mismatch tries to resync as a
// substitution first, then as an insertion or deletion of up to `maxShift`
// bytes. That keeps a single insertion from smearing the rest of the file,
// which is what defeats a naive prefix/suffix diff.
//
//   node scripts/re/alignDiff.mjs <before> <after> [--max 80] [--ctx]
import fs from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const rest = process.argv.slice(4);
const maxRows = Number(rest.includes('--max') ? rest[rest.indexOf('--max') + 1] : 80);

const a = fs.readFileSync(beforePath);
const b = fs.readFileSync(afterPath);

const TAGS = ['gRuA', 'lFuA', 'LFUA', 'karT', 'qSvE', 'qeSM', 'OCuA', 'UCuA', 'ivnE', 'qSxT', 'gnoS'];
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
  let low = 0; let high = index.length - 1; let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index[mid].at <= offset) { found = index[mid]; low = mid + 1; } else high = mid - 1;
  }
  return found;
}
const index = tagIndex(a);

const WINDOW = 32;
const MAX_SHIFT = 512;
function matchesAhead(i, j) {
  if (i + WINDOW > a.length || j + WINDOW > b.length) return false;
  for (let k = 0; k < WINDOW; k += 1) if (a[i + k] !== b[j + k]) return false;
  return true;
}

const edits = [];
let i = 0;
let j = 0;
while (i < a.length && j < b.length) {
  if (a[i] === b[j]) { i += 1; j += 1; continue; }
  // Substitution run: bytes differ but the streams stay in step.
  const startI = i;
  const startJ = j;
  let resolved = false;
  let subLength = 0;
  while (subLength < 64 && i + subLength < a.length && j + subLength < b.length) {
    subLength += 1;
    if (matchesAhead(i + subLength, j + subLength)) {
      edits.push({ kind: 'sub', at: startI, bt: startJ, length: subLength });
      i += subLength; j += subLength; resolved = true; break;
    }
  }
  if (resolved) continue;
  // Insertion into B, or deletion from A.
  let shifted = false;
  for (let d = 1; d <= MAX_SHIFT; d += 1) {
    if (matchesAhead(i, j + d)) { edits.push({ kind: 'ins', at: startI, bt: startJ, length: d }); j += d; shifted = true; break; }
    if (matchesAhead(i + d, j)) { edits.push({ kind: 'del', at: startI, bt: startJ, length: d }); i += d; shifted = true; break; }
  }
  if (shifted) continue;
  // Combined case: an insertion AND a substitution at the same spot, so neither
  // one-dimensional search resyncs. Find the nearest (di, dj) that does.
  let best = null;
  for (let total = 1; total <= 2 * MAX_SHIFT && !best; total += 1) {
    for (let di = 0; di <= Math.min(total, MAX_SHIFT); di += 1) {
      const dj = total - di;
      if (dj > MAX_SHIFT) continue;
      if (matchesAhead(i + di, j + dj)) { best = { di, dj }; break; }
    }
  }
  if (best) {
    edits.push({ kind: 'region', at: startI, bt: startJ, length: best.di, lengthB: best.dj });
    i += best.di; j += best.dj;
    continue;
  }
  edits.push({ kind: 'desync', at: i, bt: j, length: 0 });
  break;
}

console.log(`${edits.length} edit(s)\n`);
const tally = new Map();
let shown = 0;
for (const edit of edits) {
  const chunk = containing(index, edit.at);
  const tag = chunk ? `${chunk.tag}+${edit.at - chunk.at}` : `(header)+${edit.at}`;
  tally.set(chunk?.tag ?? '(header)', (tally.get(chunk?.tag ?? '(header)') ?? 0) + 1);
  if (shown >= maxRows) continue;
  shown += 1;
  if (edit.kind === 'region') {
    console.log(`REGION @${String(edit.at).padStart(7)}  ${tag.padEnd(16)} ${edit.length}b -> ${edit.lengthB}b`);
    const hexA = a.subarray(edit.at, edit.at + Math.min(edit.length, 48)).toString('hex');
    const hexB = b.subarray(edit.bt, edit.bt + Math.min(edit.lengthB, 48)).toString('hex');
    console.log(`        before ${hexA}`);
    console.log(`        after  ${hexB}`);
    continue;
  }
  if (edit.kind !== 'sub') {
    const bytes = (edit.kind === 'ins' ? b : a).subarray(edit.kind === 'ins' ? edit.bt : edit.at, (edit.kind === 'ins' ? edit.bt : edit.at) + edit.length);
    console.log(`${edit.kind.toUpperCase()} @${String(edit.at).padStart(7)}  ${tag.padEnd(16)} ${edit.length} bytes  ${bytes.toString('hex').slice(0, 64)}`);
    continue;
  }
  const hexA = a.subarray(edit.at, edit.at + edit.length).toString('hex');
  const hexB = b.subarray(edit.bt, edit.bt + edit.length).toString('hex');
  let note = '';
  if (edit.length === 4) {
    const u = a.readUInt32LE(edit.at);
    const v = b.readUInt32LE(edit.bt);
    const delta = v - u;
    note = `  u32 ${u} -> ${v} (${delta >= 0 ? '+' : ''}${delta}`;
    if (delta && delta % 3840 === 0) note += `, ${delta / 3840} BAR ticks`;
    else if (delta && delta % 960 === 0) note += `, ${delta / 960} beats`;
    if (delta && delta % 88200 === 0) note += `, ${delta / 88200} BAR samples`;
    note += ')';
  } else if (edit.length === 2) {
    note = `  u16 ${a.readUInt16LE(edit.at)} -> ${b.readUInt16LE(edit.bt)}`;
  }
  console.log(`SUB  @${String(edit.at).padStart(7)}  ${tag.padEnd(16)} ${String(edit.length).padStart(2)}b  ${hexA} -> ${hexB}${note}`);
}
console.log('\nedits by containing chunk:');
for (const [tag, count] of [...tally.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${tag.padEnd(10)} ${count}`);
