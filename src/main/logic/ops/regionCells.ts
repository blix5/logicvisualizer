import { findAllTags } from './binary';
import type { ByteRange } from './types';

// Region-cell scanning and creation: a byte-validated port of the proven
// Python ground-truth tool (logic-file-structures/mega_test/create_region.py,
// recipe proven in Logic 12.3 — see LOGIC-FILE-STRUCTURE.md §21/§21a and
// LOGIC_REGION_CREATION.md). A region is stored as a "cell": the previous
// sequence's qeSM end tag whose payload is a preamble describing the region
// that FOLLOWS (name, ids, position, length, track linkage), then the region's
// own karT + qSvE containers. Creating a region = clone a same-track template
// cell and apply four patches: the cell itself, an 80-byte unit in the arrange
// folder sequence, the creation counter, and the 0x10 size trailer. The object
// registry is never grown: when Logic left an orphan pre-allocated slot we
// consume its oid (Logic's own creation behavior), and otherwise the cell is
// written UNREGISTERED — Logic loads and displays unregistered cells and adds
// the registry records itself on the user's next save, whereas every attempt
// to append registry records ourselves made Logic reject the file as damaged
// (fresh-launch bisection on create_region_sandbox, 2026-07-05: cell+folder+
// counter variants opened clean with the region visible; registry-insert-only
// variants salvage-opened even with real stamps and header-field guesses).
// The recipe also bumps the creation counter: a u32 in a fixed early-header
// record at 0x9cc (anchored by u32 0x4c at 0x9c8 — verified across the cdefg,
// brickstone, automation_test, and mega_test project families). Logic bumps
// it by one per created sequence, and omitting the bump corrupts the project:
// an earlier build skipped it and every output crashed Logic on open, while
// the otherwise byte-identical proven artifact loads cleanly.
//
// This module deliberately does not modify parseLogicBufferRegions or the note
// splice path in logicProject.ts, which are shared with the music editor; the
// optional fill step below calls spliceLogicRegionNotes unchanged, on a splice
// target derived from the freshly written cell (payload 16, LE, notes start at
// qSvE + 36).

const LOGIC_PPQ = 960;
const BAR_TICKS = 4 * LOGIC_PPQ; // 4/4 only — callers must refuse other meters
const NOTE_BLOCK_SIZE = 32;
// Note-record positions are written with the bar-1 origin (+38400), the
// convention observed in Logic's own files; the reader strips it per region.
const BAR1_TICK_ORIGIN = 38400;

const FILE_SIZE_OFFSET = 0x10;
const NAME_LEN_OFF = 0x34; // qeSM + 0x34: u16 unpadded name length; name follows
const NAME_OFF = 0x36;
const LEN_FIELD_OFF = 0x3c; // padded name end + 0x3c: u32 region length (ticks)
const POS_FIELD_OFF = 0xe0; // padded name end + 0xe0: u32 position (ticks from bar 1, NO +38400)
const CID_PRE_OFF = 0x2c; // qeSM + 0x2c: content id of the FOLLOWING qSvE
const CACHE_MARKER_OFF = 0x4b; // padded name end + 0x4b: 0x54 marker; +1 = length-remainder cache
// padded name end + 0x4e: bit 0 set when the region is muted. Established from
// djpubichair.logicx's three "Gentle Sine Bells" copies muted at bar 65 (tracks
// 27/28/30): their cells read 0x01 here where every unmuted copy reads 0x00, and
// only 5 of the project's 301 cells carry it. This is where Logic Pro 11 keeps
// MIDI region mute; the placement's +8 = 0 (re_probe14) is a second, older form.
const MUTE_FLAG_OFF = 0x4e;
const QESM_PAYLOAD_OFF = 0x1c; // standard chunk-header length slot (bytes from header end to karT)
const CHUNK_ID_OFF = 10; // every 36-byte chunk header: [4cc][u16][u32 type][u32 id]
const CHUNK_HEADER_SIZE = 36;
const QSVE_CID_OFF = 14;
const QSVE_PAYLOAD_OFF = 28;
const TRACK_REF_BACK = 111; // qSvE - 111: u32 track ref
const TRACK_IDX_BACK = 103; // qSvE - 103: u16 ~track_index

const REG_TYPE_SEQ = 0x17;

// Creation counter: u32 at a fixed offset in the early Song header, inside a
// record anchored by the constant u32 0x4c immediately before it. Logic
// increments it once per created sequence; a mismatch corrupts the project.
const CREATION_COUNTER_OFF = 0x9cc;
const CREATION_COUNTER_ANCHOR_OFF = 0x9c8;
const CREATION_COUNTER_ANCHOR = 0x4c;
const CREATION_COUNTER_MAX_PLAUSIBLE = 1_000_000;

const FOLDER_UNIT = 80; // bytes per region event in the arrange folder sequence
const UNIT_POS_OFF = 4; // u32 event position (region pos + per-project offset)
const UNIT_FLAG_OFF = 13; // 0x05 on the LAST unit, 0x04 otherwise
const UNIT_REMAINDER_OFF = 14; // length remainder beyond whole bars: 0x20 per beat
const UNIT_GEN_OFF = 15; // save-generation flag: 0x80 on fresh creation
const UNIT_OID_OFF = 32; // u32 oid of the region the unit points at
const UNIT_FLAG_LAST = 0x05;
const UNIT_FLAG_OTHER = 0x04;
const UNIT_GEN_FRESH = 0x80;

export type RegionCell = {
  /** Offset of the opening qeSM tag (the previous sequence's end tag). */
  start: number;
  /** Offset of the next qeSM tag (or buffer end) — the cell's byte extent. */
  end: number;
  name: string;
  /** End of the even-padded name; every preamble field anchors here. */
  nameEnd: number;
  kart: number;
  qsve: number;
  lengthTicks: number;
  positionTicks: number;
  /** Region mute, stored on the definition (padded name end +0x4e bit 0) as of Logic Pro 11. */
  muted: boolean;
  preCid: number;
  qesmId: number;
  kartId: number;
  oid: number;
  cid: number;
  payload: number;
  trackRef: number;
  trackIndex: number;
};

export function describeRegionCell(cell: RegionCell): string {
  const bar = Math.floor(cell.positionTicks / BAR_TICKS) + 1;
  const beat = Math.floor((cell.positionTicks % BAR_TICKS) / LOGIC_PPQ) + 1;
  return `"${cell.name}" at bar ${bar}.${beat}, ${cell.lengthTicks / LOGIC_PPQ} beats (oid ${cell.oid})`;
}

/**
 * Scan every linked region cell (qeSM preamble whose content id matches the
 * following qSvE's). Includes empty regions, unlike parseLogicBufferRegions —
 * but also pool cells (takes/history), so the arrange folder sequence remains
 * the authoritative filter for what is actually on the timeline.
 */
export function scanRegionCells(buffer: Buffer): RegionCell[] {
  const qesms = findAllTags(buffer, 'qeSM');
  const karts = findAllTags(buffer, 'karT');
  const qsves = findAllTags(buffer, 'qSvE');
  const cells: RegionCell[] = [];
  for (let index = 0; index < qesms.length; index += 1) {
    const start = qesms[index];
    if (start === undefined) continue;
    const end = (index + 1 < qesms.length ? qesms[index + 1] : buffer.length) ?? buffer.length;
    if (start + NAME_OFF > buffer.length) continue;
    const nameLength = buffer.readUInt16LE(start + NAME_LEN_OFF);
    // Mirror the Python scanner exactly: the padded name end is computed from
    // the raw length either way; an implausible length simply fails the
    // preamble-extent check below. Only plausible names are decoded.
    const name = nameLength > 0 && nameLength < 256 && start + NAME_OFF + nameLength <= buffer.length
      ? buffer.toString('latin1', start + NAME_OFF, start + NAME_OFF + nameLength)
      : '';
    const nameEnd = start + NAME_OFF + nameLength + (nameLength & 1);
    const kart = karts.find((offset) => offset > start && offset < end);
    const qsve = qsves.find((offset) => offset > start && offset < end);
    if (kart === undefined || qsve === undefined || kart >= qsve) continue;
    if (nameEnd + POS_FIELD_OFF + 4 > end) continue;
    if (qsve - TRACK_REF_BACK < 0 || qsve + QSVE_PAYLOAD_OFF + 4 > buffer.length) continue;
    const preCid = buffer.readUInt32LE(start + CID_PRE_OFF);
    const cid = buffer.readUInt32LE(qsve + QSVE_CID_OFF);
    if (preCid !== cid) continue; // unlinked qeSM trailer — not a region cell
    cells.push({
      start,
      end,
      name,
      nameEnd,
      kart,
      qsve,
      lengthTicks: buffer.readUInt32LE(nameEnd + LEN_FIELD_OFF),
      positionTicks: buffer.readUInt32LE(nameEnd + POS_FIELD_OFF),
      muted: (buffer.readUInt8(nameEnd + MUTE_FLAG_OFF) & 0x01) !== 0,
      preCid,
      qesmId: buffer.readUInt32LE(start + CHUNK_ID_OFF),
      kartId: buffer.readUInt32LE(kart + CHUNK_ID_OFF),
      oid: buffer.readUInt32LE(qsve + CHUNK_ID_OFF),
      cid,
      payload: buffer.readUInt32LE(qsve + QSVE_PAYLOAD_OFF),
      trackRef: buffer.readUInt32LE(qsve - TRACK_REF_BACK),
      trackIndex: buffer.readUInt16LE(qsve - TRACK_IDX_BACK) ^ 0xffff,
    });
  }
  return cells;
}

export type RegistryCopy = {
  stride: number;
  hits: Array<{ offset: number; oid: number }>;
};

/**
 * Locate every copy of the object registry's type-0x17 (sequence) entries in
 * the early Song header (before the first qeSM). Two copies exist with
 * different record sizes; both end each record with [u32 type][u32 id].
 */
export function findRegistryCopies(buffer: Buffer): RegistryCopy[] {
  const firstQesm = buffer.indexOf('qeSM', 0, 'ascii');
  const limit = firstQesm > 0 ? firstQesm : buffer.length;
  const needle = Buffer.alloc(4);
  needle.writeUInt32LE(REG_TYPE_SEQ, 0);
  const header = buffer.subarray(0, limit);
  const hits: Array<{ offset: number; oid: number }> = [];
  let from = 0;
  while (from < header.length) {
    const offset = header.indexOf(needle, from);
    if (offset < 0 || offset + 8 > header.length) break;
    const oid = header.readUInt32LE(offset + 4);
    if (oid < 0x10000 && oid % 4 === 0) {
      hits.push({ offset, oid });
    }
    from = offset + 4;
  }
  // Split into copies: the oid sequence resets at a copy boundary.
  const groups: Array<Array<{ offset: number; oid: number }>> = [];
  let current: Array<{ offset: number; oid: number }> = [];
  for (const hit of hits) {
    const previous = current[current.length - 1];
    if (previous !== undefined && hit.oid <= previous.oid) {
      groups.push(current);
      current = [];
    }
    current.push(hit);
  }
  if (current.length > 0) groups.push(current);
  const copies: RegistryCopy[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const first = group[0];
    const second = group[1];
    if (first === undefined || second === undefined) continue;
    const stride = second.offset - first.offset;
    const uniform = group.every((hit, index) => (
      index === 0 || hit.offset - (group[index - 1]?.offset ?? 0) === stride
    ));
    if (uniform) copies.push({ stride, hits: group });
  }
  return copies;
}

export type FolderUnits = {
  qsveOffset: number;
  payload: number;
  unitOffsets: number[];
};

/**
 * Locate the arrange folder sequence: the qSvE whose payload is 16 + 80·n and
 * whose 80-byte units reference the given region oid. Its units are the
 * authoritative list of regions on the timeline.
 */
export function findFolderUnits(buffer: Buffer, regionOid: number): FolderUnits | null {
  for (const qsveOffset of findAllTags(buffer, 'qSvE')) {
    if (qsveOffset + QSVE_PAYLOAD_OFF + 4 > buffer.length) continue;
    const payload = buffer.readUInt32LE(qsveOffset + QSVE_PAYLOAD_OFF);
    if (payload <= 16 || (payload - 16) % FOLDER_UNIT !== 0) continue;
    const unitCount = (payload - 16) / FOLDER_UNIT;
    if (qsveOffset + CHUNK_HEADER_SIZE + unitCount * FOLDER_UNIT > buffer.length) continue;
    const unitOffsets = Array.from(
      { length: unitCount },
      (_, index) => qsveOffset + CHUNK_HEADER_SIZE + index * FOLDER_UNIT,
    );
    if (unitOffsets.some((unit) => buffer.readUInt32LE(unit + UNIT_OID_OFF) === regionOid)) {
      return { qsveOffset, payload, unitOffsets };
    }
  }
  return null;
}

function buildCellClone(
  buffer: Buffer,
  cell: RegionCell,
  name: string,
  positionTicks: number,
  lengthTicks: number,
  oid: number,
  cid: number,
): Buffer {
  const raw = buffer.subarray(cell.start, cell.end);
  const nameBytes = Buffer.from(name, 'latin1');
  const stored = nameBytes.length & 1
    ? Buffer.concat([nameBytes, Buffer.from([0])])
    : nameBytes;
  const oldStoredLength = cell.nameEnd - (cell.start + NAME_OFF);
  const lengthPrefix = Buffer.alloc(2);
  lengthPrefix.writeUInt16LE(nameBytes.length, 0);
  const clone = Buffer.concat([
    raw.subarray(0, NAME_LEN_OFF),
    lengthPrefix,
    stored,
    raw.subarray(cell.nameEnd - cell.start),
  ]);
  const shift = stored.length - oldStoredLength;
  const neRel = NAME_OFF + stored.length;
  clone.writeUInt32LE(lengthTicks, neRel + LEN_FIELD_OFF);
  clone.writeUInt32LE(positionTicks, neRel + POS_FIELD_OFF);
  // Length-remainder display cache (byte right after the 0x54 marker):
  // remainder beats beyond whole bars, in sixteenths (1 beat -> 4).
  const remainderBeats = Math.floor((lengthTicks % BAR_TICKS) / LOGIC_PPQ);
  if (clone[neRel + CACHE_MARKER_OFF] === 0x54) {
    clone[neRel + CACHE_MARKER_OFF + 1] = remainderBeats * 4;
  }
  // Ids must agree across ALL THREE chunk headers (opening qeSM, karT, qSvE) —
  // patching only the qSvE makes Logic report the project as corrupted.
  const kartRel = cell.kart - cell.start + shift;
  const qsveRel = cell.qsve - cell.start + shift;
  if (clone.toString('ascii', kartRel, kartRel + 4) !== 'karT') {
    throw new Error('Region clone failed: karT not at the expected offset after name resize.');
  }
  if (clone.toString('ascii', qsveRel, qsveRel + 4) !== 'qSvE') {
    throw new Error('Region clone failed: qSvE not at the expected offset after name resize.');
  }
  clone.writeUInt32LE(oid, CHUNK_ID_OFF);
  clone.writeUInt32LE(oid, kartRel + CHUNK_ID_OFF);
  clone.writeUInt32LE(oid, qsveRel + CHUNK_ID_OFF);
  clone.writeUInt32LE(cid, CID_PRE_OFF);
  clone.writeUInt32LE(cid, qsveRel + QSVE_CID_OFF);
  // The opening qeSM's payload-length slot (+0x1c) must equal the distance
  // from the end of its 36-byte header to the karT. Leaving it stale after a
  // name resize crashes Logic's parser deterministically (proven by bisection).
  clone.writeUInt32LE(kartRel - CHUNK_HEADER_SIZE, QESM_PAYLOAD_OFF);
  // The new region must be EMPTY regardless of the template: drop any cloned
  // note records, keeping the template's own 16-byte end sentinel, and declare
  // payload 16 (an empty region = sentinel only — the exact shape Logic itself
  // writes on creation). For an already-empty template this is a no-op that
  // reproduces the proven Python output byte-for-byte.
  const payloadStart = qsveRel + CHUNK_HEADER_SIZE;
  if (cell.payload < 16 || payloadStart + cell.payload > clone.length) {
    throw new Error('Region clone failed: the template cell\'s qSvE payload extent is implausible.');
  }
  const emptied = cell.payload === 16
    ? clone
    : Buffer.concat([
      clone.subarray(0, payloadStart),
      clone.subarray(payloadStart + cell.payload - 16),
    ]);
  emptied.writeUInt32LE(16, qsveRel + QSVE_PAYLOAD_OFF);
  return emptied;
}

function assertLatin1Name(name: string): void {
  if (name.length === 0 || name.length >= 256) {
    throw new Error('Region name must be 1–255 characters.');
  }
  for (const char of name) {
    if ((char.codePointAt(0) ?? 0) > 0xff) {
      throw new Error(`Region name contains a character Logic's format cannot store: "${char}". Use Latin-1 characters only.`);
    }
  }
}

function formatBarBeat(positionTicks: number): string {
  const bar = Math.floor(positionTicks / BAR_TICKS) + 1;
  const beat = Math.floor((positionTicks % BAR_TICKS) / LOGIC_PPQ) + 1;
  return `${bar}.${beat}`;
}
