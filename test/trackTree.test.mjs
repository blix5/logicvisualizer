import test from 'node:test';
import assert from 'node:assert/strict';
import { readArrangeTree } from '../.test-build/trackTree.mjs';

// Builds a ProjectData-shaped song-root folder with the real on-disk layouts:
// a type-0x17 qeSM cell followed by 94-byte karT track nodes.

function folderCell(name) {
  const cell = Buffer.alloc(0x36 + name.length + 8);
  cell.write('qeSM', 0, 'ascii');
  cell.writeUInt32LE(0x17, 6);
  cell.writeUInt16LE(name.length, 0x34);
  cell.write(name, 0x36, 'latin1');
  return cell;
}

function trackNode({ ordinal, ref, type = 1, depth = 0, head = false, expanded = false, payload = 58 }) {
  const node = Buffer.alloc(94);
  node.write('karT', 0, 'ascii');
  node.writeUInt32LE(ordinal, 18);
  node.writeUInt32LE(payload, 28);
  node.writeUInt16LE(type, 36);
  node.writeUInt32LE(ref, 44);
  node.writeUInt8(depth, 50);
  node.writeUInt8((head ? 0x40 : 0) | (expanded ? 0x80 : 0), 76);
  return node;
}

function project(nodes, { payload } = {}) {
  const body = nodes.map((n, i) => trackNode({ ordinal: i, payload, ...n }));
  const output = trackNode({ ordinal: nodes.length, ref: 80, type: 3, payload });
  return Buffer.concat([Buffer.alloc(64), folderCell('song'), ...body, output, Buffer.alloc(64)]);
}

test('stack members are the deeper run after their head', () => {
  const tree = readArrangeTree(project([
    { ref: 192, head: true, expanded: true },
    { ref: 88, depth: 1 },
    { ref: 136, depth: 1 },
    { ref: 196 },
  ]));
  assert.deepEqual(tree.map((t) => [t.number, t.stripRef, t.depth, t.stackHead, t.parentRef]), [
    [1, 192, 0, true, null],
    [2, 88, 1, false, 192],
    [3, 136, 1, false, 192],
    [4, 196, 0, false, null],
  ]);
  assert.equal(tree[0].expanded, true);
});

test('nested stacks close back to the right level', () => {
  const tree = readArrangeTree(project([
    { ref: 160, head: true, expanded: true },
    { ref: 88, depth: 1, head: true },
    { ref: 128, depth: 2 },
    { ref: 132, depth: 2 },
    { ref: 92, depth: 1 },
    { ref: 116 },
  ]));
  assert.deepEqual(tree.map((t) => t.parentRef), [null, 160, 88, 88, 160, null]);
  assert.equal(tree[1].expanded, false, 'a head without bit 7 is collapsed');
});

test('bit 7 means nothing on a track that is not a head', () => {
  const tree = readArrangeTree(project([{ ref: 312, expanded: true }]));
  assert.equal(tree[0].stackHead, false);
  assert.equal(tree[0].expanded, false);
});

test('older 57-byte nodes and non-1 node types are tracks too', () => {
  const tree = readArrangeTree(project([
    { ref: 324, head: true },
    { ref: 328, depth: 1 },
    { ref: 284, type: 10 },
  ], { payload: 57 }));
  assert.deepEqual(tree.map((t) => [t.number, t.nodeType]), [[1, 1], [2, 1], [3, 10]]);
});

test('a member with no head above it rejects the list', () => {
  assert.equal(readArrangeTree(project([{ ref: 88 }, { ref: 92, depth: 1 }])), null);
  assert.equal(readArrangeTree(project([{ ref: 88, head: true }, { ref: 92, depth: 2 }])), null);
});

test('no song-root folder, no tree', () => {
  assert.equal(readArrangeTree(Buffer.concat([folderCell('TRASH'), trackNode({ ordinal: 0, ref: 0 })])), null);
});
