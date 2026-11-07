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
 * Logic Pro 13 keeps the undo history inside ProjectData. After the live song it
 * appends one `UStk` chunk (bytes 'ktSU') per undo step, and each is followed
 * by a whole snapshot of the song: its own tracks, arrangement units, regions,
 * tempo and meter records. djpubichair.logicx went from 3.9 MB with one song
 * (saved by Logic 11) to 27.8 MB with 61 songs after one save in Logic 13.
 *
 * Every parser here scans the whole image for tags and markers, so it read all
 * 61 songs: 132k audio placements instead of 2k (the undo snapshots stacked on
 * top of each other), repeated meter records, and an 18 s parse. The live song
 * always comes first, so the image is cut at the first undo-stack chunk.
 *
 * The tag alone is not enough to cut on, since it could turn up in a region name
 * or a note; a chunk header follows it with a fixed shape (0x0002, then a run of
 * 0xff), as on every other chunk in the file.
 */
const UNDO_STACK_TAG = Buffer.from('ktSU', 'ascii');
const UNDO_STACK_HEADER = Buffer.from([0x02, 0x00, 0xff, 0xff, 0xff, 0xff]);

export function stripUndoHistory(image: Buffer): Buffer {
  let from = 0;
  while (from < image.length) {
    const at = image.indexOf(UNDO_STACK_TAG, from);
    if (at < 0) return image;
    const header = image.subarray(at + 4, at + 4 + UNDO_STACK_HEADER.length);
    if (header.equals(UNDO_STACK_HEADER)) return image.subarray(0, at);
    from = at + 1;
  }
  return image;
}

/**
 * An uncompressed image contains the ASCII `qSvE` sequence-event tag. When it
 * does not, scan for a zlib header and inflate from there — Logic stores some
 * alternatives (and all autosave songData) deflated with a proprietary prefix.
 * Either way, only the live song is returned; see stripUndoHistory.
 */
export function readLogicImage(filePath: string): Buffer {
  const raw = fs.readFileSync(filePath);
  if (raw.indexOf(QSVE_MARKER) >= 0) {
    return stripUndoHistory(raw);
  }
  for (const header of ZLIB_HEADERS) {
    const offset = raw.indexOf(header);
    if (offset < 0) continue;
    try {
      const inflated = zlib.inflateSync(raw.subarray(offset));
      if (inflated.indexOf(QSVE_MARKER) >= 0) return stripUndoHistory(inflated);
    } catch {
      // Not a zlib stream at this offset; try the next candidate header.
    }
  }
  return raw;
}
