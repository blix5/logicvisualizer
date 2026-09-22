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
//     +10  u32LE  SOURCE FILE oid == 4 * (index of its AuFl record). A direct
//                 file pointer, shared by every region cut from that file
//     +14  u16LE  which region of that file; the unit's +40 selects it
//     +42  u32LE  start offset within the source file, in samples (trim-in)
//     +58  u32LE  length in samples
//     +110 u16LE  name length; ASCII name at +112
//     An AuRg says WHAT a region is. It does NOT say where it sits: across 324
//     consecutive save pairs from 45 projects' own backup histories, no field in
//     it tracked a region's position.
//
//   THE ARRANGEMENT is a separate sequence: a qSvE chunk whose payload length
//   is a multiple of 80, holding one 80-byte unit per placed region.
//     +0   u16LE  0x24 — the unit marker
//     +2   u16LE  sub-tick fraction of the position (/65536), non-zero off-grid
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
/** Enumerates records that share an oid: 0, 1, 2 ... within the group. */
const AURG_ORDINAL_OFFSET = 14;
const AURG_LENGTH_SAMPLES_OFFSET = 58;
const AURG_NAME_LEN_OFFSET = 110;

const UNIT_SIZE = 80;
/** A u16, not a u32: the next two bytes carry the sub-tick fraction. */
const UNIT_MARKER = 0x24;
/**
 * u16 fraction of a tick, added to +4. Audio can be dropped at any sample and a
 * tick is 1/960 of a beat, so an unsnapped region needs finer precision than
 * whole ticks. Reading the marker as a u32 required these bytes to be zero,
 * which silently dropped every off-grid region: 1,402 placements across
 * ~/Music/Logic, carrying the full placement structure at the same rate as the
 * on-grid ones and never duplicating one.
 */
const UNIT_SUBTICK_OFFSET = 2;
const SUBTICK_SCALE = 65536;
const UNIT_POSITION_OFFSET = 4;
const UNIT_TRACK_REF_OFFSET = 16;
const UNIT_TRACK_NUMBER_OFFSET = 20;
const UNIT_ORDINAL_OFFSET = 40;
const UNIT_REGION_REF_OFFSET = 44;
/** Clip gain in whole decibels, signed. Established with re_probe10. */
const UNIT_GAIN_DB_OFFSET = 52;
/**
 * Bit 7 set when Flex is on for this region. Established with djpubichair.logicx,
 * where the user set exactly two of a track's 28 identical loop regions to flex
 * off: those two are the only ones with the bit clear (0x17 against 0x97).
 */
const UNIT_FLAGS_OFFSET = 48;
const UNIT_FLEX_BIT = 0x80;
/**
 * Bit 0 set when the region is muted. Established with re_probe12, which mutes
 * only the second of re_probe5's three regions: its +15 goes 0x00 -> 0x81,
 * while a region that is merely selected reads 0x80 (re_probe13). Across
 * ~/Music/Logic the bit is set on 2 of 13,797 placements, which is about how
 * rarely people mute regions rather than tracks.
 */
const UNIT_MUTE_OFFSET = 15;
const UNIT_MUTE_BIT = 0x01;
/**
 * Fades, in milliseconds (u16), each followed a byte later by its curve (i8,
 * -99..99, 0 = linear). Established with re_probe13 (a 1-bar fade-in on region
 * 1 and a 3-bar fade-out on region 3, at 120 BPM: +76 = 1999 and +72 = 5995,
 * i.e. 2 s and 6 s as dragged) and re_probe14 (the same fades set to ease in /
 * ease out: +79 = 98, +75 = 99). Across the corpus 2,223 placements have a
 * fade-in and 3,237 a fade-out, and all but 12 fit inside their region; the
 * commonest value is Logic's 17 ms anti-click fade-out.
 */
const UNIT_FADE_OUT_MS_OFFSET = 72;
const UNIT_FADE_OUT_CURVE_OFFSET = 75;
const UNIT_FADE_IN_MS_OFFSET = 76;
const UNIT_FADE_IN_CURVE_OFFSET = 79;

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
  /**
   * The SOURCE FILE's oid: equal to 4 x the index of its AuFl record, so the
   * file is simply parseAudioFiles()[oid / 4]. Every region cut from one file
   * shares it, which is why it is not unique per region.
   */
  oid: number;
  /** Which region cut from that file; the placement's ordinal selects it. */
  ordinal: number;
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
  /** Selects among the AuRg records sharing regionRef. */
  ordinal: number;
  /** Clip gain in decibels (whole numbers, as Logic's region inspector shows). */
  gainDb: number;
  /** Flex on: the region is time-stretched to follow project tempo. */
  flex: boolean;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  /** -99..99, 0 linear; see UNIT_FADE_IN_CURVE_OFFSET. */
  fadeInCurve: number;
  fadeOutCurve: number;
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
      ordinal: buffer.readUInt16LE(tagOffset + AURG_ORDINAL_OFFSET),
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
  const marker = Buffer.alloc(2);
  marker.writeUInt16LE(UNIT_MARKER, 0);

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
      positionTicks: rawPosition - ARRANGE_TICK_ORIGIN
        + buffer.readUInt16LE(at + UNIT_SUBTICK_OFFSET) / SUBTICK_SCALE,
      trackRef: buffer.readUInt32LE(at + UNIT_TRACK_REF_OFFSET),
      trackNumber,
      regionRef: buffer.readUInt32LE(at + UNIT_REGION_REF_OFFSET),
      ordinal: buffer.readUInt32LE(at + UNIT_ORDINAL_OFFSET),
      gainDb: buffer.readInt8(at + UNIT_GAIN_DB_OFFSET),
      flex: (buffer.readUInt8(at + UNIT_FLAGS_OFFSET) & UNIT_FLEX_BIT) !== 0,
      muted: (buffer.readUInt8(at + UNIT_MUTE_OFFSET) & UNIT_MUTE_BIT) !== 0,
      fadeInMs: buffer.readUInt16LE(at + UNIT_FADE_IN_MS_OFFSET),
      fadeOutMs: buffer.readUInt16LE(at + UNIT_FADE_OUT_MS_OFFSET),
      fadeInCurve: buffer.readInt8(at + UNIT_FADE_IN_CURVE_OFFSET),
      fadeOutCurve: buffer.readInt8(at + UNIT_FADE_OUT_CURVE_OFFSET),
    });
  }
  return units;
}

export type PlacedAudioRegion = {
  name: string;
  /** The source file's oid; look it up among parseAudioFiles() by oid. */
  fileOid: number;
  positionTicks: number;
  lengthSamples: number;
  fileStartSamples: number;
  trackRef: number;
  trackNumber: number;
  /** Clip gain in decibels; 0 unless the region inspector was used. */
  gainDb: number;
  /** Flex on: time-stretched to project tempo, so lengthSamples is NOT its timeline length. */
  flex: boolean;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  fadeInCurve: number;
  fadeOutCurve: number;
};

/**
 * Joins arrangement units to region definitions on BOTH `regionRef == oid` and
 * `unit.ordinal == region.ordinal`.
 *
 * The oid names a FILE, not a region: every region cut from one file shares it,
 * and they differ in trim and length. djpubichair.logicx has eleven regions
 * under oid 168, all cut from kadenic_sounddesign_layered-input_C.1.wav. Joining
 * on the oid alone picked an arbitrary one, which is how a region trimmed to
 * bars 82-85 once rendered full length. The unit's +40 ordinal selects the
 * right region.
 */
export function placedAudioRegions(buffer: Buffer, maxTrackNumber?: number): PlacedAudioRegion[] {
  const byKey = new Map<string, LogicAudioRegion>();
  const firstByOid = new Map<number, LogicAudioRegion>();
  for (const region of parseAudioRegions(buffer)) {
    const key = `${region.oid}:${region.ordinal}`;
    if (!byKey.has(key)) byKey.set(key, region);
    if (!firstByOid.has(region.oid)) firstByOid.set(region.oid, region);
  }
  const placed: PlacedAudioRegion[] = [];
  for (const unit of parseArrangeUnits(buffer, maxTrackNumber)) {
    // Fall back to the oid alone when no record carries that ordinal, so a
    // region still renders rather than vanishing.
    const region = byKey.get(`${unit.regionRef}:${unit.ordinal}`) ?? firstByOid.get(unit.regionRef);
    if (!region) continue;
    placed.push({
      name: region.name,
      fileOid: region.oid,
      positionTicks: unit.positionTicks,
      lengthSamples: region.lengthSamples,
      fileStartSamples: region.fileStartSamples,
      trackRef: unit.trackRef,
      trackNumber: unit.trackNumber,
      gainDb: unit.gainDb,
      flex: unit.flex,
      muted: unit.muted,
      fadeInMs: unit.fadeInMs,
      fadeOutMs: unit.fadeOutMs,
      fadeInCurve: unit.fadeInCurve,
      fadeOutCurve: unit.fadeOutCurve,
    });
  }
  return placed;
}
