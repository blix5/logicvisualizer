// The arrange track list as Logic numbers it, with track-stack nesting.
// New: Texture reads this list (ops/trackObjects.ts) but not the stack fields,
// and refuses whole projects over unrelated registry checks. See VENDORED.md,
// "Track stacks". This file must never gain a write path.

const QESM_TYPE_TRACK_FOLDER = 0x17;
const CHUNK_TYPE_OFFSET = 6;
const CELL_NAME_LENGTH_OFFSET = 0x34;
const CHUNK_PAYLOAD_OFFSET = 28;
// 58 in current projects, 57 in older ones: the same layout one trailing byte short.
const TRACK_NODE_PAYLOADS = new Set([57, 58]);
const TRACK_NODE_MIN_SIZE = 93;

const NODE_ORDINAL_OFFSET = 18;
const NODE_TYPE_OFFSET = 36;
const NODE_STRIP_REF_OFFSET = 44;
const NODE_DEPTH_OFFSET = 50;
const NODE_FLAGS_OFFSET = 76;

/** Node type of the output strip Logic parks last in the root folder; not a track. */
const NODE_TYPE_OUTPUT = 3;
const FLAG_STACK_HEAD = 0x40;
const FLAG_STACK_EXPANDED = 0x80;
/** Deeper than any stack Logic lets you build; a larger byte is not a depth. */
const MAX_DEPTH = 8;

export type ArrangeTrack = {
  /** Logic's track number, 1-based, as shown in the track header. */
  number: number;
  stripRef: number;
  /** 1 for nearly everything; 5, 6 and 10 also occur and are real tracks. */
  nodeType: number;
  /** 0 at top level, 1 inside a stack, 2 inside a stack nested in a stack. */
  depth: number;
  /** This track is a stack's main track; the tracks after it at depth + 1 are its members. */
  stackHead: boolean;
  /** Only meaningful on a stack head: its disclosure triangle is open. */
  expanded: boolean;
  /** Strip ref of the stack this track sits in, or null at top level. */
  parentRef: number | null;
};

function nodesInCell(buffer: Buffer, start: number, end: number): number[] {
  const nodes: number[] = [];
  const needle = Buffer.from('karT', 'ascii');
  for (let at = buffer.indexOf(needle, start); at >= 0 && at < end; at = buffer.indexOf(needle, at + 1)) {
    if (at + TRACK_NODE_MIN_SIZE > buffer.length) break;
    if (TRACK_NODE_PAYLOADS.has(buffer.readUInt32LE(at + CHUNK_PAYLOAD_OFFSET))) nodes.push(at);
  }
  return nodes;
}

/**
 * The song-root folder: the type-0x17 cell named after the project whose
 * track nodes end in the output node. The "Track Automation Root Folder" also
 * holds track nodes, one per strip in no useful order, but never the output
 * node type.
 */
function findSongRootNodes(buffer: Buffer): number[] | null {
  const needle = Buffer.from('qeSM', 'ascii');
  const cells: number[] = [];
  for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1)) cells.push(at);
  for (let i = 0; i < cells.length; i += 1) {
    const at = cells[i]!;
    if (at + CELL_NAME_LENGTH_OFFSET + 2 > buffer.length) continue;
    if (buffer.readUInt32LE(at + CHUNK_TYPE_OFFSET) !== QESM_TYPE_TRACK_FOLDER) continue;
    const nodes = nodesInCell(buffer, at, cells[i + 1] ?? buffer.length);
    if (nodes.some((node) => buffer.readUInt16LE(node + NODE_TYPE_OFFSET) === NODE_TYPE_OUTPUT)) return nodes;
  }
  return null;
}

/**
 * Every arrange track in Logic's order, or null when the song-root folder is
 * not found. The list is flat; stacks are encoded as a depth per track plus a
 * head flag, so members are the run of deeper tracks after their head.
 */
export function readArrangeTree(buffer: Buffer): ArrangeTrack[] | null {
  const nodes = findSongRootNodes(buffer);
  if (!nodes) return null;
  const tracks: ArrangeTrack[] = [];
  const open: ArrangeTrack[] = [];
  for (const node of nodes) {
    const nodeType = buffer.readUInt16LE(node + NODE_TYPE_OFFSET);
    if (nodeType === NODE_TYPE_OUTPUT) continue;
    const depth = buffer[node + NODE_DEPTH_OFFSET] ?? 0;
    if (depth > MAX_DEPTH) return null;
    const flags = buffer[node + NODE_FLAGS_OFFSET] ?? 0;
    while (open.length > 0 && open[open.length - 1]!.depth >= depth) open.pop();
    const parent = open[open.length - 1];
    // A member must sit exactly one level below the head it follows. Anything
    // else means these bytes are not what we think they are.
    if (depth > 0 && parent?.depth !== depth - 1) return null;
    const track: ArrangeTrack = {
      number: buffer.readUInt32LE(node + NODE_ORDINAL_OFFSET) + 1,
      stripRef: buffer.readUInt32LE(node + NODE_STRIP_REF_OFFSET),
      nodeType,
      depth,
      stackHead: (flags & FLAG_STACK_HEAD) !== 0,
      expanded: (flags & FLAG_STACK_HEAD) !== 0 && (flags & FLAG_STACK_EXPANDED) !== 0,
      parentRef: parent?.stripRef ?? null,
    };
    if (track.number !== tracks.length + 1) return null;
    tracks.push(track);
    if (track.stackHead) open.push(track);
  }
  return tracks;
}
