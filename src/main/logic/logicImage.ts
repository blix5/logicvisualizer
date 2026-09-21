// Reads a Logic ProjectData image off disk, inflating it when Logic stored it
// compressed. Extracted from Texture's logicProject.ts (readLogicImage).
import fs from 'node:fs';
import zlib from 'node:zlib';

const QSVE_MARKER = Buffer.from('qSvE', 'ascii');
const ZLIB_HEADERS = [
  Buffer.from([0x78, 0x01]),
  Buffer.from([0x78, 0x9c]),
  Buffer.from([0x78, 0xda]),
];

/**
 * An uncompressed image contains the ASCII `qSvE` sequence-event tag. When it
 * does not, scan for a zlib header and inflate from there — Logic stores some
 * alternatives (and all autosave songData) deflated with a proprietary prefix.
 */
export function readLogicImage(filePath: string): Buffer {
  const raw = fs.readFileSync(filePath);
  if (raw.indexOf(QSVE_MARKER) >= 0) {
    return raw;
  }
  for (const header of ZLIB_HEADERS) {
    const offset = raw.indexOf(header);
    if (offset < 0) continue;
    try {
      const inflated = zlib.inflateSync(raw.subarray(offset));
      if (inflated.indexOf(QSVE_MARKER) >= 0) return inflated;
    } catch {
      // Not a zlib stream at this offset; try the next candidate header.
    }
  }
  return raw;
}
