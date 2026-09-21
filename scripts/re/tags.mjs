// Census of structural chunk tags in a ProjectData image.
//
// Plugin presets embed XML and long ASCII, which swamps a naive 4-byte scan, so
// a tag only counts when it sits in BINARY context: the surrounding window must
// be mostly non-printable, which is true of real chunk headers and false of text.
//   node scripts/re/tags.mjs <ProjectData> [minCount]
import fs from 'node:fs';

const buf = fs.readFileSync(process.argv[2]);
const min = Number(process.argv[3] ?? 20);
const isAlpha = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const isPrintable = (b) => b >= 0x20 && b < 0x7f;

function binaryContext(at) {
  let printable = 0;
  let total = 0;
  for (let i = at - 24; i < at + 28; i += 1) {
    if (i < 0 || i >= buf.length) continue;
    if (i >= at && i < at + 4) continue; // skip the tag itself
    total += 1;
    if (isPrintable(buf[i])) printable += 1;
  }
  return total > 0 && printable / total < 0.4;
}

const counts = new Map();
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (!isAlpha(buf[i]) || !isAlpha(buf[i + 1]) || !isAlpha(buf[i + 2]) || !isAlpha(buf[i + 3])) continue;
  if (!binaryContext(i)) continue;
  const tag = buf.toString('latin1', i, i + 4);
  const entry = counts.get(tag) ?? { count: 0, first: i };
  entry.count += 1;
  counts.set(tag, entry);
}
const rows = [...counts.entries()].filter(([, e]) => e.count >= min).sort((a, b) => b[1].count - a[1].count);
console.log(`structural tags >= ${min} (on-disk / reversed / count / first offset):`);
for (const [tag, entry] of rows.slice(0, 40)) {
  console.log(`  ${tag}  ${[...tag].reverse().join('')}  ${String(entry.count).padStart(5)}  @${entry.first}`);
}
