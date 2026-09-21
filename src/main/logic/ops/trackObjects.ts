import crypto from 'node:crypto';
import { findAllTags } from './binary';
import type { ByteRange } from './types';

const FILE_SIZE_OFFSET = 0x10;
const HEADER_LAST_STRIP_ID_OFFSET = 0x9a;
const HEADER_CREATE_COUNTER_OFFSET = 0x9cc;
const HEADER_TRACK_COUNT_A_OFFSET = 0x10e;
const HEADER_TRACK_COUNT_B_OFFSET = 0x112;
const CHUNK_ID_OFFSET = 10;
const CHUNK_ORDINAL_OFFSET = 14;
const CHUNK_PAYLOAD_OFFSET = 28;
const QESM_TYPE_TRACK_FOLDER = 0x17;
const TRACK_NODE_PAYLOAD = 58;
const TRACK_NODE_SIZE = 94;
const AUTOMATION_UNIT_SIZE = 80;
const AUTOMATION_SENTINEL_SIZE = 16;
const REG_TERM_TYPE = 0x23;
const KNOWN_REG_TYPES = new Set([0x14, 0x16, 0x17, 0x19, 0x1e, 0x21, 0x23]);

type TaggedOffset = {
  offset: number;
  tag: string;
};

type MixerChannel = {
  offset: number;
  end: number;
  name: string | null;
  ordinal: number;
};

type PluginChannel = {
  offset: number;
  end: number;
  ordinal: number;
};

type Strip = {
  offset: number;
  end: number;
  id: number;
  name: string | null;
};

type Cell = {
  offset: number;
  end: number;
  name: string;
  id: number;
};

type TrackNode = {
  offset: number;
  ordinal: number;
  w36: number;
  w38: number;
  ref: number;
  flags: number;
};

type RegistryCopy = {
  stride: number;
  records: Array<{ type: number; id: number }>;
};

type TrackModel = {
  buffer: Buffer;
  offsets: TaggedOffset[];
  ocua: MixerChannel[];
  ucua: PluginChannel[];
  container: MixerChannel;
  activeCount: number;
  actives: MixerChannel[];
  strips: Strip[];
  click: Strip | null;
  placeholder: MixerChannel | null;
  placeholderIssue: string | null;
  instNumber: number | null;
  placeholderActiveIndex: number;
  husk: MixerChannel | null;
  huskActiveIndex: number;
  root: Cell;
  rootNodes: TrackNode[];
  automationCell: Cell;
  automationCells: Cell[];
  automationNodes: TrackNode[];
  automationQSveOffset: number;
  automationUnits: number[];
  automationCellByRef: Map<number, Cell>;
  newStripId: number;
  newCellId: number;
  cellContentIds: Set<number>;
};

export type ListedLogicTrack = {
  number: number;
  name: string;
  strip_id: number;
  strip_ref: number;
  arrange_ordinal: number;
  selected: boolean;
};

function readCStringLatin1(buffer: Buffer, offset: number, maxLength = 64): string | null {
  if (offset < 0 || offset >= buffer.length) return null;
  const end = buffer.indexOf(0, offset);
  if (end < 0 || end > offset + maxLength) return null;
  for (let index = offset; index < end; index += 1) {
    const byte = buffer[index];
    if (byte === undefined || byte < 0x20 || byte >= 0x7f) return null;
  }
  return buffer.toString('latin1', offset, end);
}

// Every real ivnE chunk carries its Envi registry-pool type here (25131 of
// 25133 raw text hits across the full 634-file wild survey, 2026-07-11; the
// 2 outliers are "ivnE" text inside base64-like blob data).
const ENVI_CHUNK_TYPE = 0x14;

function allTagOffsets(buffer: Buffer): TaggedOffset[] {
  const hits: TaggedOffset[] = [];
  for (const tag of ['qeSM', 'qSvE', 'karT', 'OCuA', 'ivnE', 'UCuA', 'qSxT', 'MneG', 'gnaB']) {
    for (const offset of findAllTags(buffer, tag)) {
      // "AivnE" is NOT a distinct tag: all 34 sightings in the wild survey
      // are a chunk whose last byte happens to be 0x41 ('A') followed by a
      // real ivnE chunk. The old shadow rule read them the other way
      // around — dropping the real strip and cutting the previous strip's
      // extent one byte short (motion.logicx "Otherworldly Oceans"). The
      // pool type at +6 is the decisive discriminator for both that
      // collision and raw "ivnE" text inside chunk data.
      if (tag === 'ivnE'
        && (offset + CHUNK_ID_OFFSET > buffer.length || buffer.readUInt32LE(offset + 6) !== ENVI_CHUNK_TYPE)) {
        continue;
      }
      hits.push({ offset, tag });
    }
  }
  return hits.sort((left, right) => left.offset - right.offset);
}

function extent(offsets: TaggedOffset[], index: number, fileLength: number): { start: number; end: number } {
  const here = offsets[index];
  const next = offsets[index + 1];
  return {
    start: here?.offset ?? 0,
    end: next ? next.offset : fileLength,
  };
}

function cellName(buffer: Buffer, qesmOffset: number): string {
  const length = buffer.readUInt16LE(qesmOffset + 0x34);
  if (length > 0 && length < 256 && qesmOffset + 0x36 + length <= buffer.length) {
    return buffer.toString('latin1', qesmOffset + 0x36, qesmOffset + 0x36 + length);
  }
  return '';
}

function stripName(buffer: Buffer, offset: number, end: number): string | null {
  const length = buffer.readUInt16LE(offset + 0xc2);
  if (length > 0 && length < 64 && offset + 0xc4 + length <= end) {
    const raw = buffer.subarray(offset + 0xc4, offset + 0xc4 + length);
    if ([...raw].every((byte) => byte >= 0x20 && byte < 0x7f)) {
      return raw.toString('latin1');
    }
  }
  return null;
}

function type17Cells(buffer: Buffer): Cell[] {
  const qesms = findAllTags(buffer, 'qeSM');
  const cells: Cell[] = [];
  for (let index = 0; index < qesms.length; index += 1) {
    const offset = qesms[index];
    if (offset === undefined) continue;
    const end = (index + 1 < qesms.length ? qesms[index + 1] : buffer.length) ?? buffer.length;
    if (offset + 14 <= buffer.length && buffer.readUInt32LE(offset + 6) === QESM_TYPE_TRACK_FOLDER) {
      cells.push({
        offset,
        end,
        name: cellName(buffer, offset),
        id: buffer.readUInt32LE(offset + CHUNK_ID_OFFSET),
      });
    }
  }
  return cells;
}

function trackNodes(buffer: Buffer, start: number, end: number): TrackNode[] {
  const nodes: TrackNode[] = [];
  for (const offset of findAllTags(buffer, 'karT')) {
    if (offset <= start || offset >= end) continue;
    if (offset + TRACK_NODE_SIZE > buffer.length) continue;
    if (buffer.readUInt32LE(offset + CHUNK_PAYLOAD_OFFSET) !== TRACK_NODE_PAYLOAD) continue;
    nodes.push({
      offset,
      ordinal: buffer.readUInt32LE(offset + 18),
      w36: buffer.readUInt16LE(offset + 36),
      w38: buffer.readUInt16LE(offset + 38),
      ref: buffer.readUInt32LE(offset + 44),
      flags: buffer.readUInt32LE(offset + 76),
    });
  }
  return nodes;
}

function parseRegistries(buffer: Buffer): RegistryCopy[] {
  const term = Buffer.alloc(8);
  term.writeUInt32LE(REG_TERM_TYPE, 0);
  term.writeUInt32LE(0xffffffff, 4);
  const firstQesm = buffer.indexOf('qeSM', 0, 'ascii');
  const limit = firstQesm > 0 ? firstQesm : buffer.length;
  const copies: RegistryCopy[] = [];
  let position = 0;
  while (position < limit) {
    const terminator = buffer.indexOf(term, position);
    if (terminator < 0 || terminator >= limit) break;
    position = terminator + 4;
    for (const stride of [24, 16]) {
      const records: Array<{ type: number; id: number }> = [];
      for (let offset = terminator - stride; offset >= 0; offset -= stride) {
        const type = buffer.readUInt32LE(offset);
        const id = buffer.readUInt32LE(offset + 4);
        if (!KNOWN_REG_TYPES.has(type) || type === REG_TERM_TYPE || id > 0xfffff) break;
        records.push({ type, id });
      }
      if (records.length >= 2) {
        copies.push({ stride, records: records.reverse() });
        break;
      }
    }
  }
  return copies;
}

function parseTrackModel(buffer: Buffer): TrackModel {
  if (buffer.length < FILE_SIZE_OFFSET + 4 || buffer.readUInt32LE(FILE_SIZE_OFFSET) !== buffer.length - 24) {
    throw new Error('refusing: ProjectData size trailer at 0x10 is incoherent.');
  }

  const offsets = allTagOffsets(buffer);
  const ocua: MixerChannel[] = [];
  const ucua: PluginChannel[] = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const hit = offsets[index];
    if (hit === undefined) continue;
    const { end } = extent(offsets, index, buffer.length);
    if (hit.tag === 'OCuA') {
      ocua.push({
        offset: hit.offset,
        end,
        name: readCStringLatin1(buffer, hit.offset + 0x60),
        ordinal: buffer.readUInt32LE(hit.offset + CHUNK_ORDINAL_OFFSET),
      });
    } else if (hit.tag === 'UCuA') {
      ucua.push({
        offset: hit.offset,
        end,
        ordinal: buffer.readUInt32LE(hit.offset + CHUNK_ORDINAL_OFFSET),
      });
    }
  }
  const container = ocua[0];
  if (!container || container.end - container.offset <= 600) {
    throw new Error('mixer container not found where expected (first OCuA).');
  }
  const activeCount = buffer[container.offset + 0x70];
  const actives = ocua.slice(1).filter((channel) => {
    const size = channel.end - channel.offset;
    const name = channel.name;
    return !((name ?? '').startsWith(' Bus') || name === '' || size <= 218);
  });
  if (actives.length !== activeCount) {
    throw new Error(`active-channel scan (${actives.length}) != container count (${activeCount}); refusing.`);
  }

  const strips: Strip[] = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const hit = offsets[index];
    if (hit === undefined || hit.tag !== 'ivnE') continue;
    const { end } = extent(offsets, index, buffer.length);
    strips.push({
      offset: hit.offset,
      end,
      id: buffer.readUInt32LE(hit.offset + CHUNK_ID_OFFSET),
      name: stripName(buffer, hit.offset, end),
    });
  }
  // The Click/placeholder machinery is a create_track precondition, not a
  // listing one: failures here are recorded as placeholderIssue so listing
  // still works and only track creation refuses.
  const clicks = strips.filter((strip) => strip.name === 'Click');
  let click: Strip | null = null;
  let placeholder: MixerChannel | null = null;
  let instNumber: number | null = null;
  let placeholderIssue: string | null = null;
  if (clicks.length !== 1) {
    placeholderIssue = `expected exactly 1 'Click' strip, found ${clicks.length}.`;
  } else {
    click = clicks[0]!;
    // The placeholder's tail ff+UUID field is NOT at a fixed offset: it sits
    // at a form-dependent distance from the channel start (+0xe0 in the
    // 273 B baseline, +0xec in 285 B forms, +0xf0 in 289 B forms), so scan
    // the channel's whole extent for the 17-byte needle.
    const needle = Buffer.concat([
      Buffer.from([0xff]),
      buffer.subarray(click.offset + 0x1e9, click.offset + 0x1f9),
    ]);
    const carriers = actives.filter((channel) => {
      const hit = buffer.indexOf(needle, channel.offset);
      return hit >= 0 && hit + needle.length <= channel.end;
    });
    const carrierName = carriers[0]?.name;
    if (carriers.length !== 1) {
      placeholderIssue = carriers.length === 0
        ? "no active channel carries the Click's link UUID."
        : `${carriers.length} active channels carry the Click's link UUID; refusing to pick one.`;
    } else if (!carrierName?.startsWith(' Inst ')) {
      placeholderIssue = `placeholder channel named ${JSON.stringify(carrierName)}, not ' Inst N'.`;
    } else {
      const parsed = Number.parseInt(carrierName.slice(6), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        placeholderIssue = `placeholder channel named ${JSON.stringify(carrierName)}, not ' Inst N'.`;
      } else {
        placeholder = carriers[0]!;
        instNumber = parsed;
      }
    }
  }
  const placeholderActiveIndex = placeholder ? actives.indexOf(placeholder) : -1;
  const husk = actives.find((channel) => isRecyclableHusk(buffer, channel)) ?? null;
  const huskActiveIndex = husk ? actives.indexOf(husk) : -1;

  const cells = type17Cells(buffer);
  const automationMatches = cells.filter((cell) => cell.name === 'Track Automation Root Folder');
  if (automationMatches.length !== 1) {
    throw new Error('automation root folder cell not found.');
  }
  const automationCell = automationMatches[0];
  const automationCells = cells.filter((cell) => cell.name === '*Automation');
  let root: Cell | null = null;
  let rootNodes: TrackNode[] = [];
  for (const cell of cells) {
    const nodes = trackNodes(buffer, cell.offset, cell.end);
    if (nodes.some((node) => node.w36 === 3)) {
      root = cell;
      rootNodes = nodes;
    }
  }
  if (!root) {
    throw new Error('song-root cell (with master karT node) not found.');
  }
  if (rootNodes[rootNodes.length - 1]?.w36 !== 3) {
    throw new Error('master node is not last in the song-root cell; refusing.');
  }
  if (!automationCell) {
    throw new Error('track-automation folder cell not found.');
  }
  const automationNodes = trackNodes(buffer, automationCell.offset, automationCell.end);
  const automationQSves = findAllTags(buffer, 'qSvE').filter((offset) => offset > automationCell.offset && offset < automationCell.end);
  if (automationQSves.length !== 1) {
    throw new Error('automation folder must hold exactly one qSvE.');
  }
  const automationQSveOffset = automationQSves[0];
  if (automationQSveOffset === undefined) {
    throw new Error('automation folder qSvE offset missing.');
  }
  const automationPayload = buffer.readUInt32LE(automationQSveOffset + CHUNK_PAYLOAD_OFFSET);
  if ((automationPayload - AUTOMATION_SENTINEL_SIZE) % AUTOMATION_UNIT_SIZE !== 0) {
    throw new Error(`automation qSvE payload ${automationPayload} is not 16+80n.`);
  }
  const automationUnits = Array.from(
    { length: (automationPayload - AUTOMATION_SENTINEL_SIZE) / AUTOMATION_UNIT_SIZE },
    (_, index) => automationQSveOffset + 36 + AUTOMATION_UNIT_SIZE * index,
  );
  const automationCellByRef = new Map<number, Cell>();
  for (const cell of automationCells) {
    automationCellByRef.set(buffer.readUInt32LE(cell.offset + 0x10e), cell);
  }

  const ids = new Map<number, Set<number>>([[0x14, new Set()], [0x17, new Set()]]);
  for (const copy of parseRegistries(buffer)) {
    for (const record of copy.records) {
      ids.get(record.type)?.add(record.id);
    }
  }
  const stripIds = ids.get(0x14);
  const cellIds = ids.get(0x17);
  if (!stripIds || stripIds.size === 0 || !cellIds || cellIds.size === 0) {
    throw new Error('object registry strip/cell ids not found; refusing to allocate track ids.');
  }
  const cellContentIds = new Set<number>();
  for (const offset of findAllTags(buffer, 'qSvE')) {
    if (offset + 18 <= buffer.length) cellContentIds.add(buffer.readUInt32LE(offset + 14));
  }

  return {
    buffer,
    offsets,
    ocua,
    ucua,
    container,
    activeCount,
    actives,
    strips,
    click,
    placeholder,
    placeholderIssue,
    instNumber,
    placeholderActiveIndex,
    husk,
    huskActiveIndex,
    root,
    rootNodes,
    automationCell,
    automationCells,
    automationNodes,
    automationQSveOffset,
    automationUnits,
    automationCellByRef,
    // Continue each pool's id sequence past BOTH the registry and the
    // in-file chunk headers: our own creations stay unregistered (the
    // proven no-grow doctrine — Logic registers them on its next save), so
    // a registry-only max would re-mint the same oid on a second create
    // before a save, and §21a pins duplicate oids as a corruption class.
    newStripId: Math.max(...stripIds, ...strips.map((strip) => strip.id)) + 4,
    newCellId: Math.max(...cellIds, ...cells.map((cell) => cell.id)) + 4,
    cellContentIds,
  };
}

// Placeholder OCuA forms vary in size across a project's life (249B..321B+
// observed in the wild, always 237+4k). Every activatable form shares the
// first-0xa8-byte layout and differs only inside the growth zone
// 0xa8..tail: one lone 01-dword at +0xb0, an optional (1,1) dword pair at
// tail-0x1c/tail-0x18, zeros elsewhere; then the ff+UUID tail field at
// end-49 and the canonical ee..80 00 80 0c block at end-32. Rather than
// whitelisting sizes, verify that structure exhaustively — a placeholder
// passing this gate is byte-equivalent to the proven 273B/285B ground
// truths modulo zero padding, so the (byte-proven) activation recipe
// collapses it to the same canonical 237B active channel. The 253B
// degenerate form (no pair) is additionally proven directly against
// Logic's own steal output (testign.logicx " Inst 1", 2026-07-10).
// Forms this structural check refuses (e.g. the 01-dword at +0xb4 with
// +0xb0 = 0 seen in older projects) get one more chance: the in-file
// clone-inversion self-proof in selfProvePlaceholderForm below, which
// accepts a variant only when the project's own bytes prove the recipe
// reproduces Logic's output exactly.
const MIN_PLACEHOLDER_SIZE = 249; // smallest form observed in the wild
const PLACEHOLDER_TAIL_FROM_END = 49;
const ACTIVE_CHANNEL_SIZE = 237;
// end-32 onward: ee, 5 zeros, 80 00 80 0c, zeros to end
const PLACEHOLDER_POST_EE = Buffer.from([0xee, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0x0c, 0]);

// Deleting a software-instrument track leaves its 237 B channel behind as a
// dormant husk: UUID zeroed, activation byte +0x80 off, the (1,1) pair at
// +0x3c/+0x3d zeroed, ee-tail byte 0x0c instead of the active 0x05, and
// +0x75 parked at 8 — everything else keeps the activated-channel layout
// (payload 201, volumes 90, old +0xa4 instrument index and +0x7e routing
// byte). When creating the next track Logic ALWAYS reactivates the first
// husk in file order instead of stealing the Click placeholder (bk03->bk04
// and motion ground-truth pairs, decoded 2026-07-10). The predicate demands
// the exact byte pattern shared by every observed husk so a misparsed
// record can never be "recycled".
function isRecyclableHusk(buffer: Buffer, channel: MixerChannel): boolean {
  const { offset, end, name } = channel;
  if (end - offset !== ACTIVE_CHANNEL_SIZE) return false;
  if (!/^ Inst \d+$/.test(name ?? '')) return false;
  if (buffer.readUInt32LE(offset + 0x1c) !== ACTIVE_CHANNEL_SIZE - 36) return false;
  for (let index = 0x3c; index < 0x40; index += 1) {
    if (buffer[offset + index] !== 0) return false;
  }
  if (buffer[offset + 0x74] !== 0 || buffer[offset + 0x75] !== 8) return false;
  if (buffer[offset + 0x76] !== 0 || buffer[offset + 0x77] !== 0 || buffer[offset + 0x78] !== 0) return false;
  if (buffer[offset + 0x79] !== 90 || buffer[offset + 0x9b] !== 90) return false;
  if (buffer[offset + 0x7a] !== 0 || buffer[offset + 0x7b] !== 0 || buffer[offset + 0x7c] !== 0) return false;
  if (buffer[offset + 0x80] !== 0) return false;
  for (let index = 0xa8; index < 0xbc; index += 1) {
    if (buffer[offset + index] !== 0) return false;
  }
  if (buffer[offset + 0xbc] !== 0xff) return false;
  for (let index = 0xbd; index < 0xcd; index += 1) {
    if (buffer[offset + index] !== 0) return false;
  }
  const tail = buffer.subarray(offset + ACTIVE_CHANNEL_SIZE - 32, offset + ACTIVE_CHANNEL_SIZE);
  if (!tail.subarray(0, PLACEHOLDER_POST_EE.length).equals(PLACEHOLDER_POST_EE)) return false;
  for (let index = PLACEHOLDER_POST_EE.length; index < tail.length; index += 1) {
    if (tail[index] !== 0) return false;
  }
  return true;
}

const PLACEHOLDER_NAME_DIGIT_OFFSET = 0x60 + Buffer.byteLength(' Inst ', 'latin1');

// The Click template stores 'Click' as 5-in-6; a track name whose padded
// length differs resizes the cloned ivnE strip.
const CLICK_STORED_NAME_LENGTH = 6;

export function listLogicTracks(buffer: Buffer): ListedLogicTrack[] {
  const model = parseTrackModel(buffer);
  const stripsById = new Map(model.strips.map((strip) => [strip.id, strip]));
  const userNodes = model.rootNodes.filter((node) => node.w36 === 1);
  return userNodes.map((node, index) => {
    const strip = stripsById.get(node.ref);
    return {
      number: index + 1,
      name: strip?.name ?? `Track ${index + 1}`,
      strip_id: node.ref,
      strip_ref: node.ref,
      arrange_ordinal: node.ordinal,
      selected: Boolean(node.flags & 0x20) || Boolean(strip && buffer[strip.offset + 0x74] !== 0),
    };
  });
}
