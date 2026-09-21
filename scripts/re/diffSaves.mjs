// Differential save diff: the tool for locating a field whose meaning you know
// but whose offset you do not. Byte-diff two ProjectData images, group the
// changed bytes into runs, and annotate each run with the chunk it falls inside
// and its offset RELATIVE TO THAT CHUNK'S TAG -- which is the number you need,
// since absolute offsets shift on every save.
//
//   node scripts/re/diffSaves.mjs <before> <after> [--tag gRuA] [--max 60]
import fs from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const args = process.argv.slice(4);
const onlyTag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
const maxRows = Number(args.includes('--max') ? args[args.indexOf('--max') + 1] : 60);

const a = fs.readFileSync(beforePath);
const b = fs.readFileSync(afterPath);

// The u32 at 0x10 is the total file size. It changes whenever anything is
// inserted, and being 16 bytes in it would otherwise truncate the common-prefix
// scan to nothing, hiding the edit you actually care about. Mask it out.
const FILE_SIZE_OFFSET = 0x10;
const maskedA = Buffer.from(a);
const maskedB = Buffer.from(b);
maskedA.writeUInt32LE(0, FILE_SIZE_OFFSET);
maskedB.writeUInt32LE(0, FILE_SIZE_OFFSET);

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

/** Nearest tag at or before `offset`, by binary search. */
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

// Align the two images. Identical sizes diff directly; otherwise trim the common
// prefix and suffix so an insertion elsewhere does not smear the whole diff.
let aStart = 0;
let bStart = 0;
let aEnd = a.length;
let bEnd = b.length;
if (a.length !== b.length) {
  while (aStart < aEnd && bStart < bEnd && maskedA[aStart] === maskedB[bStart]) { aStart += 1; bStart += 1; }
  while (aEnd > aStart && bEnd > bStart && maskedA[aEnd - 1] === maskedB[bEnd - 1]) { aEnd -= 1; bEnd -= 1; }
  console.log(`sizes differ (${a.length} -> ${b.length}); common prefix ${aStart}, common suffix ${a.length - aEnd}`);
  console.log(`changed span: before[${aStart}..${aEnd}) after[${bStart}..${bEnd})\n`);
}

const index = tagIndex(a);
const afterIndex = tagIndex(b);

if (a.length !== b.length) {
  const chunkA = containing(index, aStart);
  const chunkB = containing(afterIndex, bStart);
  console.log(`span starts in  before: ${chunkA?.tag ?? '(none)'}+${chunkA ? aStart - chunkA.at : aStart}`);
  console.log(`span starts in   after: ${chunkB?.tag ?? '(none)'}+${chunkB ? bStart - chunkB.at : bStart}\n`);
  const dump = (buf, from, to, label) => {
    const limit = Math.min(to, from + 512);
    console.log(`${label} [${from}..${to}) ${to - from} bytes${to > limit ? ' (first 512)' : ''}:`);
    for (let at = from; at < limit; at += 16) {
      const slice = buf.subarray(at, Math.min(at + 16, limit));
      const text = slice.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      console.log(`  ${String(at).padStart(8)}  ${slice.toString('hex').padEnd(32)}  |${text}|`);
    }
    console.log();
  };
  dump(a, aStart, aEnd, 'BEFORE');
  dump(b, bStart, bEnd, 'AFTER');
  process.exit(0);
}

const runs = [];
if (a.length === b.length) {
  let at = 0;
  while (at < a.length) {
    if (a[at] === b[at]) { at += 1; continue; }
    const start = at;
    // Join runs separated by fewer than 4 identical bytes so a u32 whose middle
    // byte happens to match still reads as one field.
    let gap = 0;
    while (at < a.length && gap < 4) {
      if (a[at] === b[at]) gap += 1; else gap = 0;
      at += 1;
    }
    runs.push({ start, end: at - gap });
  }
}

console.log(`${runs.length} changed run(s)${onlyTag ? ` (showing ${onlyTag} only)` : ''}\n`);
let shown = 0;
const byTag = new Map();
for (const run of runs) {
  const chunk = containing(index, run.start);
  const tag = chunk?.tag ?? '(none)';
  byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
  if (onlyTag && tag !== onlyTag) continue;
  if (shown >= maxRows) continue;
  shown += 1;
  const length = run.end - run.start;
  const rel = chunk ? run.start - chunk.at : run.start;
  const before = a.subarray(run.start, run.end).toString('hex');
  const after = b.subarray(run.start, run.end).toString('hex');
  let delta = '';
  if (length === 4) {
    const x = a.readUInt32LE(run.start);
    const y = b.readUInt32LE(run.start);
    delta = `  u32 ${x} -> ${y}  (${y - x >= 0 ? '+' : ''}${y - x}${(y - x) % 960 === 0 ? `, ${(y - x) / 960} beats` : ''})`;
  }
  console.log(`@${String(run.start).padStart(8)}  ${tag}+${String(rel).padStart(5)}  len ${String(length).padStart(3)}  ${before} -> ${after}${delta}`);
}
console.log('\nruns per containing chunk:');
for (const [tag, count] of [...byTag.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${tag.padEnd(8)} ${count}`);
}
