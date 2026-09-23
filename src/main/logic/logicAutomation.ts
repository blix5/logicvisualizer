// Track automation.
//
// NOT vendored — Texture parses no automation. Reverse-engineered against
// re_probe9.logicx, a project whose only edit was a volume ramp from 0 dB at
// bar 1 to -inf at bar 21.
//
// Automation lives in its own qSvE chunk whose payload is a whole number of
// 16-byte records:
//
//   +0  u16    0x0050 record marker
//   +4  u32    position in TICKS, origin 38400 (the MIDI origin, NOT the
//              arrangement's 34560)
//   +8  u32    value in 8.24 fixed point: value / 2^24 gives Logic fader
//              units, where 90 == 0 dB and 0 == -inf
//   +12 u32    parameter id in the low byte (7 = volume, 0x0a = pan), with
//              0x40000000 set on every point after the lane's first
//
// Several parameters share ONE chunk, interleaved: re_probe11 automates volume
// and pan on the same track and yields a single 3116-record list holding 2925
// volume points and 191 pan points. Splitting on the parameter id is what
// separates them; without it the pan points look like out-of-range volume.
//
// Logic writes automation DENSELY rather than as control points: the probe's
// single straight ramp is stored as 2925 records, one roughly every 26 ticks.
// Decoded, they fall on a straight line from 90.000 to 0.000 fader units with a
// maximum deviation of 0.0022 units, which is what confirmed the encoding.
//
// Note the value is NOT a float32. Reading those bytes as a float produces a
// smooth-looking curve decaying from 9e15 to 1.9e-37 — plausible enough to fool
// a range check, which is exactly the trap an earlier attempt fell into. The
// give-away is that the top byte falls linearly: 0x5a, 0x53, 0x4d, 0x47 ...
import { LOGIC_BAR1_TICK_ORIGIN } from '../../shared/timebase';
import { FADER_UNITY } from '../../shared/automation';
import { scanRegionCells } from './ops/regionCells';

const QSVE_TAG = 'qSvE';
const QSVE_BLOCK_LENGTH_OFFSET = 28;
const QSVE_BLOCK_LENGTH_BIAS = 16;
const QSVE_FIRST_RECORD_OFFSET = 36;

const RECORD_SIZE = 16;
const RECORD_MARKER = 0x0050;
// Float-valued records share the chunk: 0x0051 with a float32 at +8 (0.866 in
// bassthing), most likely plugin-parameter automation. Not decoded; skipped.
const FLOAT_RECORD_MARKER = 0x0051;
// Bytes +2..3: a fraction of a tick (/ 65536), as on arrangement placements.
const SUBTICK_OFFSET = 2;
const SUBTICK_SCALE = 65536;
const POSITION_OFFSET = 4;
const VALUE_OFFSET = 8;
const PARAMETER_OFFSET = 12;
/** The value is 8.24 fixed point. */
const VALUE_SCALE = 1 << 24;

export { FADER_UNITY };
/** Pan is 0..127 with this as centre; 0 is hard left, 127 hard right. */
export const PAN_CENTRE = 64;

export const AUTOMATION_PARAM_VOLUME = 0x07;
export const AUTOMATION_PARAM_PAN = 0x0a;
const MIN_RECORDS = 4;
const MAX_PLAUSIBLE_TICK = LOGIC_BAR1_TICK_ORIGIN + 50_000_000;
const MAX_PLAUSIBLE_FADER = 200;

export type AutomationPoint = {
  /** Ticks from bar 1. */
  positionTicks: number;
  /**
   * Raw parameter units. For volume, 90 is unity (0 dB) and 0 is -inf; for pan,
   * 64 is centre. Left raw because the meaning depends on the parameter.
   */
  value: number;
};

export type AutomationLane = {
  /** Byte offset of the owning qSvE. */
  chunkOffset: number;
  /** Low byte of the record's +12 field; 7 is volume, 0x0a is pan. */
  parameterId: number;
  points: AutomationPoint[];
  /**
   * The track the lane belongs to, or null when unattributed. See
   * attributeAutomationLanes().
   */
  trackRef: number | null;
};

function findAllTags(buffer: Buffer, tag: string): number[] {
  const needle = Buffer.from(tag, 'ascii');
  const offsets: number[] = [];
  let from = 0;
  while (from < buffer.length) {
    const at = buffer.indexOf(needle, from);
    if (at < 0) break;
    offsets.push(at);
    from = at + 1;
  }
  return offsets;
}

/**
 * Every automation lane in the file. `automationChunks` names the qSvE chunks
 * known to be automation (their cell is named "*Automation"); in those, any row
 * that is not a 0x0050 record is skipped. Anywhere else an unknown row rejects
 * the chunk, since it is probably not automation at all.
 *
 * Real automation carries far more than 0x0050 rows: markers 0x51-0x58 (with
 * parameter ids like 0x1d, float-valued: plugin parameters, not decoded), 0x8050
 * and, in djpubichair, 0xe0. Rejecting a whole chunk on them dropped 27 of the
 * 96 volume lanes in ~/Music/Logic, among them djpubichair's "drums" stack, whose
 * owner drew 0 dB at bar 25 to -inf at bar 41 on a chunk also holding 182 rows
 * of marker 0x54.
 */
export function parseAutomationLanes(buffer: Buffer, automationChunks: ReadonlySet<number> = new Set()): AutomationLane[] {
  const lanes: AutomationLane[] = [];
  for (const tagOffset of findAllTags(buffer, QSVE_TAG)) {
    if (tagOffset + QSVE_BLOCK_LENGTH_OFFSET + 4 > buffer.length) continue;
    const payload = buffer.readUInt32LE(tagOffset + QSVE_BLOCK_LENGTH_OFFSET) - QSVE_BLOCK_LENGTH_BIAS;
    if (payload <= 0 || payload % RECORD_SIZE !== 0) continue;
    const count = payload / RECORD_SIZE;
    if (count < MIN_RECORDS) continue;
    const first = tagOffset + QSVE_FIRST_RECORD_OFFSET;
    if (first + payload > buffer.length) continue;
    const known = automationChunks.has(tagOffset);

    // Points for every parameter share the chunk, so collect per parameter id.
    const byParameter = new Map<number, AutomationPoint[]>();
    let valid = true;
    let previousTick = -1;
    let pointCount = 0;
    for (let i = 0; i < count; i += 1) {
      const at = first + i * RECORD_SIZE;
      const marker = buffer.readUInt16LE(at);
      // Logic interleaves other 16-byte rows into a real list, exactly as in
      // the tempo list: float-valued records, and meta rows whose first six
      // bytes are zero (a marker such as 0xbb follows). bassthing.logicx's
      // volume lanes carry both, and rejecting the chunk on them dropped every
      // lane in the project.
      if (marker === FLOAT_RECORD_MARKER) continue;
      if (marker === 0 && buffer.readUInt32LE(at + 2) === 0) continue;
      if (known && marker !== RECORD_MARKER) continue;
      if (marker !== RECORD_MARKER) { valid = false; break; }
      pointCount += 1;
      const rawTick = buffer.readUInt32LE(at + POSITION_OFFSET)
        + buffer.readUInt16LE(at + SUBTICK_OFFSET) / SUBTICK_SCALE;
      const value = buffer.readUInt32LE(at + VALUE_OFFSET) / VALUE_SCALE;
      // Automation is written in time order; a list that is not sorted, or that
      // carries an out-of-range value, is some other 16-byte structure.
      if (rawTick < LOGIC_BAR1_TICK_ORIGIN || rawTick > MAX_PLAUSIBLE_TICK) { valid = false; break; }
      if (rawTick < previousTick) { valid = false; break; }
      if (!(value >= 0 && value <= MAX_PLAUSIBLE_FADER)) { valid = false; break; }
      previousTick = rawTick;
      const parameterId = buffer.readUInt32LE(at + PARAMETER_OFFSET) & 0xff;
      const list = byParameter.get(parameterId);
      const point = { positionTicks: rawTick - LOGIC_BAR1_TICK_ORIGIN, value };
      if (list) list.push(point);
      else byParameter.set(parameterId, [point]);
    }
    if (!valid || pointCount < MIN_RECORDS) continue;
    for (const [parameterId, points] of byParameter) {
      if (points.length < MIN_RECORDS) continue;
      lanes.push({ chunkOffset: tagOffset, parameterId, points, trackRef: null });
    }
  }
  return lanes;
}

/**
 * Sets each lane's trackRef from the region cell that owns its chunk.
 *
 * An automation list is stored as a sequence exactly like a MIDI region: a
 * region cell named "*Automation" whose qSvE IS the automation chunk, and whose
 * preamble carries the track ref at qSvE - 111 like any other cell. Every lane
 * in re_probe9/11 and all eight in arp swell beat sit in such a cell, and the
 * refs name the tracks you would expect: four of its "Bright Synth Lead" layers
 * (the arp swells), the 808 bass, a reverb aux, and "guitar feedback thing"
 * (volume and pan).
 */
export function attributeAutomationLanes(
  buffer: Buffer,
  lanes: AutomationLane[],
  cells: ReturnType<typeof scanRegionCells> = scanRegionCells(buffer),
): AutomationLane[] {
  const refByQsve = new Map<number, number>();
  for (const cell of cells) refByQsve.set(cell.qsve, cell.trackRef);
  return lanes.map((lane) => ({ ...lane, trackRef: refByQsve.get(lane.chunkOffset) ?? null }));
}

/** Every automation lane, attributed to its track. */
export function parseAttributedAutomationLanes(buffer: Buffer): AutomationLane[] {
  const cells = scanRegionCells(buffer);
  const automationChunks = new Set(cells.filter((cell) => cell.name === '*Automation').map((cell) => cell.qsve));
  return attributeAutomationLanes(buffer, parseAutomationLanes(buffer, automationChunks), cells);
}

/**
 * Volume automation per track ref, with each lane's points in time order. A
 * track with more than one volume lane (none seen yet) keeps the longest.
 */
export function parseTrackVolumeAutomation(buffer: Buffer): Map<number, AutomationPoint[]> {
  const byRef = new Map<number, AutomationPoint[]>();
  for (const lane of parseAttributedAutomationLanes(buffer)) {
    if (lane.parameterId !== AUTOMATION_PARAM_VOLUME || lane.trackRef === null) continue;
    const existing = byRef.get(lane.trackRef);
    if (!existing || lane.points.length > existing.length) byRef.set(lane.trackRef, lane.points);
  }
  return byRef;
}

/**
 * Fader units to decibels by the MIDI volume law, 40·log10(v/90): exact at
 * unity (90) and -inf (0), and it reproduces the fader's +6 dB ceiling at 127.
 * Confirmed at a third point: bassthing's Aux 3 stores 58.8, which Logic shows as -7.4 dB.
 */
export function faderToDecibels(fader: number): number {
  if (fader <= 0) return -Infinity;
  return 40 * Math.log10(fader / FADER_UNITY);
}

/** Pan units to Logic's -64..+63 display scale. */
export function panToDisplay(value: number): number {
  return value - PAN_CENTRE;
}
