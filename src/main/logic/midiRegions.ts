// MIDI region + note extraction.
//
// THREE sources are joined here, because none is complete on its own:
//   - the arrangement placement records below give a region's POSITION and
//     TRACK. These are the authority on where a region sits.
//   - scanRegionCells() (vendored) gives its NAME and LENGTH, and the byte
//     offset of its note block.
//   - the note-block walk gives the NOTES.
//
// Using the cell's own positionTicks instead of a placement record is what made
// MIDI regions render at the wrong times and overlap each other: the cell scan
// also returns pool and take entries, whose position/length fields are not
// timeline values at all (mega_test.logicx yields cells at tick 0 claiming to be
// 2000 bars long, named "Untitled", on track ref 0). Only cells referenced by a
// placement record are on the timeline.
//
// MIDI placements are 80-byte records like the audio ones, but with marker 0x20
// rather than 0x24, and the region ref in a DIFFERENT slot: +8 (mirrored at
// +32) where audio uses +44. Position shares the arrangement origin of 34560.
//
// Three gotchas, the first two carried over verbatim from Texture:
//   1. The note block has NO FIXED STRIDE. Logic interleaves 16-byte pad chunks
//      between 32-byte note records but omits the pad after freshly inserted
//      notes, so the walk must advance at 16-byte granularity.
//   2. The block-length field may be little- OR big-endian depending on the
//      project. Always probe both (readNoteBlockLength).
//   3. A note's position is SIGNED about an origin of 38400: a note played
//      just ahead of its region's start, or left hidden by trimming the
//      region's left edge, is stored below the origin. Reading those as
//      unsigned ticks from 0 dropped early-played first notes (keshi beat
//      v33's violas, limbo's violas) and drew others bars late.
import { scanRegionCells, type RegionCell } from './ops/regionCells';
import { ARRANGE_TICK_ORIGIN } from './logicAudio';

export const LOGIC_PPQ = 960;
export const LOGIC_BAR1_TICK_ORIGIN = 38400;

const NOTE_BLOCK_SIZE = 32;
const NOTE_PAD_CHUNK_SIZE = 16;
const NOTE_BLOCK_END_SENTINEL = 0xf1;
/** Note-on, any channel: the low nibble is the MIDI channel. */
const NOTE_STATUS = 0x90;
const STATUS_TYPE_MASK = 0xf0;
const NOTE_END_MARKER = 0x89;
const NOTE_END_MARKER_OFFSET = 23;
const NOTE_POS_OFFSET = 4;
const NOTE_VELOCITY_OFFSET = 11;
const NOTE_PITCH_OFFSET = 12;
// +16 is release (note-off) velocity, NOT duration (Logic default 0x40=64).
// The real duration is a u32 LE at +28.
const NOTE_DURATION_OFFSET = 28;
const QSVE_COUNT_OFFSET = 28;
const QSVE_TO_FIRST_NOTE = 36;
const MAX_REASONABLE_NOTES = 200_000;

export type LogicNote = {
  /** Ticks from the start of the owning region; negative if it starts before it. */
  startTicks: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
};

export type ParsedMidiRegion = {
  qSveOffset: number;
  name: string;
  trackRef: number;
  /** 1-based, as shown in Logic's track list. */
  trackNumber: number;
  /** Ticks from bar 1, taken from the placement record. */
  positionTicks: number;
  lengthTicks: number;
  /** Pitches as stored in the note block, NOT transposed. */
  notes: LogicNote[];
  muted: boolean;
  /** Region Transpose in semitones; what Logic plays is note.pitch + transpose. */
  transpose: number;
};

export type MidiPlacement = {
  positionTicks: number;
  trackRef: number;
  trackNumber: number;
  regionRef: number;
  /**
   * +8 cleared while the +32 ref survives. NOT region mute, whatever it is:
   * re_probe15's unmuted transposed copy has it. Only used to reject stray
   * per-track records, which share the shape.
   */
  playRefCleared: boolean;
  /** Region Transpose in semitones (+53, i8). */
  transpose: number;
};

const PLACEMENT_SIZE = 80;
const PLACEMENT_MARKER = 0x20;
const PLACEMENT_POSITION_OFFSET = 4;
const PLACEMENT_REGION_REF_OFFSET = 8;
const PLACEMENT_REGION_MIRROR_OFFSET = 32;
const PLACEMENT_TRACK_REF_OFFSET = 16;
const PLACEMENT_TRACK_NUMBER_OFFSET = 20;
// i8 semitones, the region inspector's Transpose. Shared with audio units; see
// UNIT_TRANSPOSE_OFFSET in logicAudio.ts.
const PLACEMENT_TRANSPOSE_OFFSET = 53;
const MAX_PLAUSIBLE_TICK = ARRANGE_TICK_ORIGIN + 10_000_000;
/** Beyond this a "region" is a pool entry, not something on the timeline. */
const MAX_PLAUSIBLE_LENGTH_TICKS = 400 * 4 * LOGIC_PPQ;
/** One sixteenth. Cleared-ref candidates shorter than this are stray track records. */
const MIN_CLEARED_REF_LENGTH_TICKS = LOGIC_PPQ / 4;

/**
 * Scans for MIDI placement records. Like the audio scan, this must step one
 * byte at a time: the records are not 4-byte aligned in the file.
 */
export function parseMidiPlacements(buffer: Buffer, maxTrackNumber: number): MidiPlacement[] {
  const placements: MidiPlacement[] = [];
  // u16, as for audio: bytes +2..3 carry a sub-tick fraction for off-grid
  // placements, so a u32 match would drop every unsnapped region.
  const marker = Buffer.alloc(2);
  marker.writeUInt16LE(PLACEMENT_MARKER, 0);
  let from = 0;
  while (from < buffer.length) {
    const at = buffer.indexOf(marker, from);
    if (at < 0) break;
    from = at + 1;
    if (at + PLACEMENT_SIZE > buffer.length) break;

    const rawPosition = buffer.readUInt32LE(at + PLACEMENT_POSITION_OFFSET);
    const trackNumber = buffer.readUInt8(at + PLACEMENT_TRACK_NUMBER_OFFSET);
    const playRef = buffer.readUInt32LE(at + PLACEMENT_REGION_REF_OFFSET);
    const regionRef = buffer.readUInt32LE(at + PLACEMENT_REGION_MIRROR_OFFSET);
    if (rawPosition < ARRANGE_TICK_ORIGIN || rawPosition > MAX_PLAUSIBLE_TICK) continue;
    if (trackNumber < 1 || trackNumber > maxTrackNumber) continue;
    if (regionRef === 0) continue;
    // Normally the ref is mirrored at +8 and +32, and requiring both to agree
    // rejects most stray 0x20 bytes. Some placements clear +8 and keep +32.
    // This was read as region mute from re_probe14, whose muted copy has it,
    // but re_probe15's UNMUTED transposed copy has it too, and only 1 of the 27
    // such placements in the corpus has a muted cell. Mute is the cell flag.
    // Every track also carries a bar-1 record shaped the same way, but its +32
    // names no region cell, so the cell join drops it.
    const playRefCleared = playRef === 0;
    if (!playRefCleared && playRef !== regionRef) continue;

    placements.push({
      positionTicks: rawPosition - ARRANGE_TICK_ORIGIN + buffer.readUInt16LE(at + 2) / 65536,
      trackRef: buffer.readUInt32LE(at + PLACEMENT_TRACK_REF_OFFSET),
      trackNumber,
      regionRef,
      playRefCleared,
      transpose: buffer.readInt8(at + PLACEMENT_TRANSPOSE_OFFSET),
    });
  }
  return placements;
}

/** Probes LE then BE, accepting only a length that is 16-byte aligned and fits. */
function readNoteBlockLength(buffer: Buffer, qSveOffset: number): number | null {
  const offset = qSveOffset + QSVE_COUNT_OFFSET;
  if (offset + 4 > buffer.length) return null;
  const noteBlocksStart = qSveOffset + QSVE_TO_FIRST_NOTE;
  const remaining = buffer.length - noteBlocksStart;
  for (const value of [buffer.readUInt32LE(offset), buffer.readUInt32BE(offset)]) {
    if (
      value >= 16
      && (value - 16) % NOTE_PAD_CHUNK_SIZE === 0
      && (value - 16) / NOTE_BLOCK_SIZE <= MAX_REASONABLE_NOTES
      && value - 16 <= remaining
    ) {
      return value - 16;
    }
  }
  return null;
}

function ticksFromOrigin(raw: number): number {
  return raw - LOGIC_BAR1_TICK_ORIGIN;
}

/**
 * Clips notes to a region's own span, the way Logic sounds them.
 *
 * A note block is the region's full CONTENT, which can be longer than the
 * region: trimming a region's end leaves the trimmed-off notes in the block.
 * 194 of the 2,047 MIDI regions in ~/Music/Logic have notes running past their
 * end, by up to 10 bars — those were all being drawn.
 *
 * The start is different: a note that begins before the region but is still
 * sounding at its start is kept at its true position. 77 notes in 62 regions
 * of the corpus start early, mostly by a few ticks to a beat, played ahead of
 * the downbeat that opens the region. Notes that END by the region's start are
 * what a left-edge trim hides, and are dropped.
 */
function clipNotesToRegion(notes: LogicNote[], lengthTicks: number): LogicNote[] {
  if (lengthTicks <= 0) return notes;
  const clipped: LogicNote[] = [];
  for (const note of notes) {
    if (note.startTicks >= lengthTicks) continue;
    if (note.startTicks + note.durationTicks <= 0) continue;
    const available = lengthTicks - note.startTicks;
    clipped.push(note.durationTicks <= available
      ? note
      : { ...note, durationTicks: available });
  }
  return clipped;
}

/** Walks one qSvE payload at 16-byte granularity, collecting 32-byte note records. */
export function readRegionNotes(buffer: Buffer, qSveOffset: number): LogicNote[] {
  const payloadLength = readNoteBlockLength(buffer, qSveOffset);
  if (payloadLength === null) return [];
  const notes: LogicNote[] = [];
  const start = qSveOffset + QSVE_TO_FIRST_NOTE;
  const end = Math.min(start + payloadLength, buffer.length);
  let at = start;
  while (at + NOTE_BLOCK_SIZE <= end) {
    if (buffer.readUInt8(at) === NOTE_BLOCK_END_SENTINEL) break;
    if (
      (buffer.readUInt8(at) & STATUS_TYPE_MASK) === NOTE_STATUS
      && buffer.readUInt8(at + NOTE_END_MARKER_OFFSET) === NOTE_END_MARKER
    ) {
      notes.push({
        startTicks: ticksFromOrigin(buffer.readUInt32LE(at + NOTE_POS_OFFSET)),
        durationTicks: buffer.readUInt32LE(at + NOTE_DURATION_OFFSET),
        pitch: buffer.readUInt8(at + NOTE_PITCH_OFFSET),
        velocity: buffer.readUInt8(at + NOTE_VELOCITY_OFFSET),
      });
      at += NOTE_BLOCK_SIZE;
    } else {
      at += NOTE_PAD_CHUNK_SIZE;
    }
  }
  return notes;
}

export function parseMidiRegions(buffer: Buffer, maxTrackNumber: number): ParsedMidiRegion[] {
  const cellsByOid = new Map<number, RegionCell>();
  for (const cell of scanRegionCells(buffer)) {
    if (!cellsByOid.has(cell.oid)) cellsByOid.set(cell.oid, cell);
  }

  const regions: ParsedMidiRegion[] = [];
  const seen = new Set<string>();
  for (const placement of parseMidiPlacements(buffer, maxTrackNumber)) {
    const cell = cellsByOid.get(placement.regionRef);
    if (!cell) continue;
    if (cell.lengthTicks <= 0 || cell.lengthTicks > MAX_PLAUSIBLE_LENGTH_TICKS) continue;
    // A per-track bar-1 record can land on a cell by accident; across
    // ~/Music/Logic the four that did were all nameless, noteless and
    // near-zero length, while every genuine muted region is at least bars long.
    if (placement.playRefCleared && cell.lengthTicks < MIN_CLEARED_REF_LENGTH_TICKS) continue;

    // The same placement can appear more than once in the scan; one region per
    // (track, position, content) is what the timeline actually shows.
    const key = `${placement.trackRef}:${placement.positionTicks}:${placement.regionRef}`;
    if (seen.has(key)) continue;
    seen.add(key);

    regions.push({
      qSveOffset: cell.qsve,
      name: cell.name,
      trackRef: placement.trackRef,
      trackNumber: placement.trackNumber,
      positionTicks: placement.positionTicks,
      lengthTicks: cell.lengthTicks,
      notes: clipNotesToRegion(readRegionNotes(buffer, cell.qsve), cell.lengthTicks),
      // Region mute is on the cell (+0x4e bit 0): djpubichair's bar-65 copies
      // and re_probe14's muted copy both carry it.
      muted: cell.muted,
      transpose: placement.transpose,
    });
  }
  return regions;
}
