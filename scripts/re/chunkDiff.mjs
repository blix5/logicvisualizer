// Structural diff: pairs up the chunks of two ProjectData images and compares
// each pair at offsets RELATIVE TO ITS OWN TAG. Immune to insertions elsewhere
// in the file, which defeat a plain byte diff by shifting every later offset.
//
//   node scripts/re/chunkDiff.mjs <before> <after> [--tag gRuA] [--max 40]
import fs from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const rest = process.argv.slice(4);
const onlyTag = rest.includes('--tag') ? rest[rest.indexOf('--tag') + 1] : null;
const maxRows = Number(rest.includes('--max') ? rest[rest.indexOf('--max') + 1] : 40);

const TAGS = ['gRuA', 'lFuA', 'LFUA', 'karT', 'qSvE', 'qeSM', 'OCuA', 'UCuA', 'ivnE', 'qSxT', 'gnoS'];

function chunks(buf) {
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
  all.sort((x, y) => x.at - y.at);
  return all.map((chunk, i) => ({
    ...chunk,
    end: all[i + 1] === undefined ? buf.length : all[i + 1].at,
  }));
}

const a = fs.readFileSync(beforePath);
const b = fs.readFileSync(afterPath);
const ca = chunks(a);
const cb = chunks(b);

console.log(`chunks: before ${ca.length}, after ${cb.length}`);
const seqA = ca.map((c) => c.tag).join(',');
const seqB = cb.map((c) => c.tag).join(',');
if (seqA !== seqB) {
  console.log('chunk SEQUENCES DIFFER — a chunk was added or removed; pairing by index is unsafe.');
}

// Bytes before the first chunk are the Song header; diff them too, or an edit
// stored in a fixed header array is invisible.
{
  const headerEnd = Math.min(ca[0]?.at ?? 0, cb[0]?.at ?? 0);
  const diffs = [];
  let at = 0;
  while (at < headerEnd) {
    if (a[at] === b[at]) { at += 1; continue; }
    const start = at;
    let gap = 0;
    while (at < headerEnd && gap < 4) { if (a[at] === b[at]) gap += 1; else gap = 0; at += 1; }
    diffs.push({ start, end: at - gap });
  }
  if (diffs.length) {
    console.log(`\nHEADER [0..${headerEnd}) — ${diffs.length} differing run(s)`);
    for (const d of diffs.slice(0, 30)) {
      const size = d.end - d.start;
      let note = '';
      if (size === 4) {
        const u = a.readUInt32LE(d.start);
        const v = b.readUInt32LE(d.start);
        const delta = v - u;
        note = `  u32 ${u} -> ${v} (${delta >= 0 ? '+' : ''}${delta}`;
        if (delta && delta % 3840 === 0) note += `, ${delta / 3840} BAR`;
        else if (delta && delta % 960 === 0) note += `, ${delta / 960} beats`;
        else if (delta && delta % 88200 === 0) note += `, ${delta / 88200} bar @44.1k samples`;
        note += ')';
      }
      console.log(`    @${String(d.start).padStart(6)} len ${String(size).padStart(3)}  ${a.subarray(d.start, d.end).toString('hex')} -> ${b.subarray(d.start, d.end).toString('hex')}${note}`);
    }
  }
}

let shown = 0;
const tally = new Map();
const pairCount = Math.min(ca.length, cb.length);
for (let i = 0; i < pairCount; i += 1) {
  const x = ca[i];
  const y = cb[i];
  if (x.tag !== y.tag) { console.log(`index ${i}: ${x.tag} vs ${y.tag} — stopping`); break; }
  const lenX = x.end - x.at;
  const lenY = y.end - y.at;
  const span = Math.min(lenX, lenY);
  const diffs = [];
  let at = 0;
  while (at < span) {
    if (a[x.at + at] === b[y.at + at]) { at += 1; continue; }
    const start = at;
    let gap = 0;
    while (at < span && gap < 4) {
      if (a[x.at + at] === b[y.at + at]) gap += 1; else gap = 0;
      at += 1;
    }
    diffs.push({ start, end: at - gap });
  }
  if (lenX !== lenY) diffs.push({ lengthChange: lenY - lenX });
  if (diffs.length === 0) continue;
  tally.set(x.tag, (tally.get(x.tag) ?? 0) + 1);
  if (onlyTag && x.tag !== onlyTag) continue;
  if (shown >= maxRows) continue;
  shown += 1;
  console.log(`\n#${i} ${x.tag} @${x.at} -> @${y.at}${lenX !== lenY ? `  (chunk length ${lenX} -> ${lenY})` : ''}`);
  for (const d of diffs) {
    if (d.lengthChange !== undefined) { console.log(`    chunk grew by ${d.lengthChange} bytes`); continue; }
    const size = d.end - d.start;
    const hexA = a.subarray(x.at + d.start, x.at + d.end).toString('hex');
    const hexB = b.subarray(y.at + d.start, y.at + d.end).toString('hex');
    let note = '';
    if (size === 4) {
      const u = a.readUInt32LE(x.at + d.start);
      const v = b.readUInt32LE(y.at + d.start);
      const delta = v - u;
      note = `  u32 ${u} -> ${v}  (${delta >= 0 ? '+' : ''}${delta}`;
      if (delta !== 0 && delta % 3840 === 0) note += `, ${delta / 3840} BAR`;
      else if (delta !== 0 && delta % 960 === 0) note += `, ${delta / 960} beats`;
      else if (delta !== 0 && delta % 88200 === 0) note += `, ${delta / 88200} bar @44.1k samples`;
      note += ')';
    } else if (size === 2) {
      const u = a.readUInt16LE(x.at + d.start);
      const v = b.readUInt16LE(y.at + d.start);
      note = `  u16 ${u} -> ${v} (${v - u >= 0 ? '+' : ''}${v - u})`;
    }
    console.log(`    +${String(d.start).padStart(4)} len ${String(size).padStart(3)}  ${hexA} -> ${hexB}${note}`);
  }
}
console.log('\nchunks differing, by tag:');
for (const [tag, count] of [...tally.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${tag.padEnd(6)} ${count}`);
}
