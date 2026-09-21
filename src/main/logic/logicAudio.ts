// Audio file, audio region and ARRANGEMENT extraction.
//
// NOT vendored — Texture parses no audio at all. Reverse-engineered against
// ~/Music/Logic plus four controlled probe projects (re_probe1..4) built in
// Logic specifically to isolate one edit each: a one-bar move, a two-bar
// lengthen, and a move to another track.
//
// Tags are byte-reversed, as everywhere in ProjectData.
//
//   AuFl / AUFL  (bytes 'lFuA' / 'LFUA')  audio file records
//     The filename sits IMMEDIATELY BEFORE the LFUA tag, encoded UTF-16LE,
//     with a u16LE character count at (nameStart - 2). Grepping the buffer for
//     ASCII '.wav' finds nothing, which is what hid this at first.
//
//   AuRg         (bytes 'gRuA')           audio region definitions
//     +10  u32LE  this region's oid, as referenced by an arrangement unit
//     +42  u32LE  start offset within the source file, in samples (trim-in)
//     +58  u32LE  length in samples
//     +110 u16LE  name length; ASCII name at +112
//     An AuRg says WHAT a region is. It does NOT say where it sits: across 324
//     consecutive save pairs from 45 projects' own backup histories, no field in
//     it tracked a region's position.
//
//   THE ARRANGEMENT is a separate sequence: a qSvE chunk whose payload length
//   is a multiple of 80, holding one 80-byte unit per placed region.
//     +0   u32LE  always 0x24 — the unit marker, used to validate the list
//     +4   u32LE  position in TICKS, origin 34560 == bar 1 (note: NOT the 38400
//                 origin that MIDI notes, tempo and markers use)
//     +13  u8     selected flag; changes as you click around, ignore it
//     +16  u32LE  track ref
//     +20  u8     1-based track number
//     +44  u32LE  region ref — matches an AuRg's +10
//
//   This is also why AuRg counts dwarf the visible arrangement: every take,
//   comp and pool entry has a definition, but only the units place anything.
//
// EVIDENCE (re_probe1 -> 2 -> 3 -> 4, all at 120 BPM, 4/4):
//   probe1 units decode to bars 1, 5, 17 on tracks 1, 2, 3 with lengths
//   4, 8 and 2 bars — exactly how the probe was built, and confirmed against
//   each project's own WindowImage.jpg.
//   probe2 (clip 2 moved one bar right): unit1 +4 goes 49920 -> 53760, a delta
//   of exactly 3840 ticks = one bar. Nothing else of substance changes.
//   probe3 (clip 3 lengthened two bars): that region's AuRg +58 goes
//   176400 -> 352800 samples = 2 bars -> 4 bars at 120 BPM. The units do not move.
//   probe4 (clip 1 moved to track 3): unit0 +16 goes 88 -> 96 and +20 goes
//   1 -> 3. Its position is untouched.

const AUFL_TAG = 'LFUA';
const AURG_TAG = 'gRuA';

const AURG_OID_OFFSET = 10;
const AURG_FILE_START_OFFSET = 42;
const AURG_LENGTH_SAMPLES_OFFSET = 58;
const AURG_NAME_LEN_OFFSET = 110;

const UNIT_SIZE = 80;
const UNIT_MARKER = 0x24;
const UNIT_POSITION_OFFSET = 4;
const UNIT_TRACK_REF_OFFSET = 16;
const UNIT_TRACK_NUMBER_OFFSET = 20;
const UNIT_REGION_REF_OFFSET = 44;
/** Clip gain in whole decibels, signed. Established with re_probe10. */
const UNIT_GAIN_DB_OFFSET = 52;

export const LOGIC_PPQ = 960;
/** Bar 1 in the arrangement sequence. Deliberately not the MIDI 38400 origin. */
export const ARRANGE_TICK_ORIGIN = 34560;
/** ~2600 bars at 4/4 — far past any real song, but rejects garbage. */
const MAX_PLAUSIBLE_TICK = ARRANGE_TICK_ORIGIN + 10_000_000;
/** Guards against a stray 0x24 that happens to sit before a plausible u32. */
const MAX_TRACK_NUMBER = 255;
const AURG_NAME_OFFSET = 112;

const MAX_NAME_LENGTH = 200;

export type LogicAudioFile = {
  index: number;
  /** The value AuRg records reference: 4 * index. */
  oid: number;
  fileName: string;
};

export type LogicAudioRegion = {
  /** Referenced by an arrangement unit's regionRef. */
  oid: number;
  name: string;
  lengthSamples: number;
  /** Where in the source file this region starts, in samples (trim-in). */
  fileStartSamples: number;
};

export type LogicArrangeUnit = {
  /** Ticks from bar 1 (the ARRANGE_TICK_ORIGIN has already been removed). */
  positionTicks: number;
  trackRef: number;
  /** 1-based, as shown in Logic's track list. */
  trackNumber: number;
  regionRef: number;
  /** Clip gain in decibels (whole numbers, as Logic's region inspector shows). */
  gainDb: number;
};

function findAllTags(buffer: Buffer, tag: string): number[] {
  const needle = Buffer.from(tag, 'ascii');
  const offsets: number[] = [];
  let from = 0;
  while (from < buffer.length) {
    const offset = buffer.indexOf(needle, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + 1;
  }
  return offsets;
}

/**
 * Walks back from the LFUA tag looking for a UTF-16LE run whose length matches
 * the u16 count that precedes it. Only one candidate length can satisfy both.
 */
function readAuFlName(buffer: Buffer, tagOffset: number): string | null {
  let found: string | null = null;
  for (let length = 1; length <= MAX_NAME_LENGTH; length += 1) {
    const start = tagOffset - 2 * length;
    if (start - 2 < 0) break;
    if (buffer.readUInt16LE(start - 2) !== length) continue;
    const candidate = buffer.toString('utf16le', start, tagOffset);
    if (/^[\x20-\x7e]+$/.test(candidate)) found = candidate;
  }
  return found;
}

export function parseAudioFiles(buffer: Buffer): LogicAudioFile[] {
  const files: LogicAudioFile[] = [];
  const tags = findAllTags(buffer, AUFL_TAG);
  for (let index = 0; index < tags.length; index += 1) {
    const tagOffset = tags[index];
    if (tagOffset === undefined) continue;
    const fileName = readAuFlName(buffer, tagOffset);
    if (!fileName) continue;
    files.push({ index, oid: index * 4, fileName });
  }
  return files;
}

export function parseAudioRegions(buffer: Buffer): LogicAudioRegion[] {
  const regions: LogicAudioRegion[] = [];
  for (const tagOffset of findAllTags(buffer, AURG_TAG)) {
    if (tagOffset + AURG_NAME_OFFSET + 2 > buffer.length) continue;
    const nameLength = buffer.readUInt16LE(tagOffset + AURG_NAME_LEN_OFFSET);
    if (nameLength <= 0 || nameLength > MAX_NAME_LENGTH) continue;
    const nameEnd = tagOffset + AURG_NAME_OFFSET + nameLength;
    if (nameEnd > buffer.length) continue;
    regions.push({
      oid: buffer.readUInt32LE(tagOffset + AURG_OID_OFFSET),
      name: buffer.toString('latin1', tagOffset + AURG_NAME_OFFSET, nameEnd),
      lengthSamples: buffer.readUInt32LE(tagOffset + AURG_LENGTH_SAMPLES_OFFSET),
      fileStartSamples: buffer.readUInt32LE(tagOffset + AURG_FILE_START_OFFSET),
    });
  }
  return regions;
}

/**
 * Finds arrangement units anywhere in the image.
 *
 * Deliberately NOT framed by the qSvE payload field. Two things make that
 * framing unusable on real projects:
 *   - the records are not 4-byte aligned (solace.logicx's first unit sits at
 *     offset 889245), so any scan that steps by 4 walks straight past them;
 *   - a real arrangement chunk interleaves other record types, so the 80-byte
 *     grid is not contiguous across the whole payload.
 * Instead, find every 0x24 marker and keep the ones whose position and track
 * number are plausible. Validity is checked per record, so an interleaved
 * foreign record costs one unit rather than the whole list.
 */
export function parseArrangeUnits(buffer: Buffer, maxTrackNumber = MAX_TRACK_NUMBER): LogicArrangeUnit[] {
  const units: LogicArrangeUnit[] = [];
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(UNIT_MARKER, 0);

  let from = 0;
  while (from < buffer.length) {
    const at = buffer.indexOf(marker, from);
    if (at < 0) break;
    from = at + 1;
    if (at + UNIT_SIZE > buffer.length) break;

    const rawPosition = buffer.readUInt32LE(at + UNIT_POSITION_OFFSET);
    const trackNumber = buffer.readUInt8(at + UNIT_TRACK_NUMBER_OFFSET);
    if (rawPosition < ARRANGE_TICK_ORIGIN || rawPosition > MAX_PLAUSIBLE_TICK) continue;
    if (trackNumber < 1 || trackNumber > maxTrackNumber) continue;

    units.push({
      positionTicks: rawPosition - ARRANGE_TICK_ORIGIN,
      trackRef: buffer.readUInt32LE(at + UNIT_TRACK_REF_OFFSET),
      trackNumber,
      regionRef: buffer.readUInt32LE(at + UNIT_REGION_REF_OFFSET),
      gainDb: buffer.readInt8(at + UNIT_GAIN_DB_OFFSET),
    });
  }
  return units;
}

export type PlacedAudioRegion = {
  name: string;
  positionTicks: number;
  lengthSamples: number;
  fileStartSamples: number;
  trackRef: number;
  trackNumber: number;
  /** Clip gain in decibels; 0 unless the region inspector was used. */
  gainDb: number;
};

/**
 * Joins arrangement units to region definitions on `unit.regionRef == AuRg.oid`.
 *
 * Where an oid is shared by several definitions (Logic reuses one for a region
 * and its copies) the first is taken; in every observed case the duplicates
 * agree on length.
 */
export function placedAudioRegions(buffer: Buffer, maxTrackNumber?: number): PlacedAudioRegion[] {
  const byOid = new Map<number, LogicAudioRegion>();
  for (const region of parseAudioRegions(buffer)) {
    if (!byOid.has(region.oid)) byOid.set(region.oid, region);
  }
  const placed: PlacedAudioRegion[] = [];
  for (const unit of parseArrangeUnits(buffer, maxTrackNumber)) {
    const region = byOid.get(unit.regionRef);
    if (!region) continue;
    placed.push({
      name: region.name,
      positionTicks: unit.positionTicks,
      lengthSamples: region.lengthSamples,
      fileStartSamples: region.fileStartSamples,
      trackRef: unit.trackRef,
      trackNumber: unit.trackNumber,
      gainDb: unit.gainDb,
    });
  }
  return placed;
}
