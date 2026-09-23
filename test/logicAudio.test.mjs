import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAudioFiles, parseAudioRegions, parseArrangeUnits, placedAudioRegions, ARRANGE_TICK_ORIGIN,
} from '../.test-build/logicAudio.mjs';

const BAR_TICKS = 3840;

// Builds ProjectData-shaped buffers using the real on-disk layouts, so the
// parser exercises its actual code paths rather than a simplified stand-in.

function auFl(fileName) {
  const name = Buffer.from(fileName, 'utf16le');
  const record = Buffer.alloc(2 + name.length + 4 + 200);
  record.writeUInt16LE(fileName.length, 0);
  name.copy(record, 2);
  record.write('LFUA', 2 + name.length, 'ascii');
  return record;
}

function auRg({ name, oid, ordinal = 0, lengthSamples = 88_200, fileStartSamples = 0, muted = false }) {
  const record = Buffer.alloc(300);
  record.write('gRuA', 0, 'ascii');
  record.writeUInt32LE(oid, 10);
  record.writeUInt16LE(ordinal, 14);
  // +41 flags byte: mute is bit 1 (0x02).
  record.writeUInt8(muted ? 0x02 : 0x00, 41);
  record.writeUInt32LE(fileStartSamples, 42);
  record.writeUInt32LE(lengthSamples, 58);
  record.writeUInt16LE(name.length, 110);
  record.write(name, 112, 'latin1');
  return record;
}

/** A qSvE whose payload is a whole number of 80-byte arrangement units. */
function arrangeList(units, { markerFor = () => 0x24 } = {}) {
  const payload = units.length * 80;
  const chunk = Buffer.alloc(36 + payload + 8);
  chunk.write('qSvE', 0, 'ascii');
  chunk.writeUInt32LE(payload + 16, 28); // block length carries a +16 bias
  units.forEach((unit, i) => {
    const at = 36 + i * 80;
    chunk.writeUInt32LE(markerFor(i), at);
    chunk.writeUInt32LE(ARRANGE_TICK_ORIGIN + unit.bar * BAR_TICKS, at + 4);
    chunk.writeUInt16LE(unit.subtick ?? 0, at + 2);
    chunk.writeUInt32LE(unit.trackRef ?? 88, at + 16);
    chunk.writeUInt8(unit.trackNumber ?? 1, at + 20);
    chunk.writeUInt32LE(unit.ordinal ?? 0, at + 40);
    chunk.writeUInt32LE(unit.regionRef, at + 44);
    // +48 flags byte: baseline 0x17, flex is bit 7 (0x80), reverse is bit 5 (0x20).
    chunk.writeUInt8(0x17 | (unit.flex ? 0x80 : 0) | (unit.reversed ? 0x20 : 0), at + 48);
    chunk.writeInt8(unit.gainDb ?? 0, at + 52);
    // A selected region reads 0x80 here; mute is bit 0 on top of it.
    chunk.writeUInt8((unit.selected ? 0x80 : 0) | (unit.muted ? 0x01 : 0), at + 15);
    chunk.writeUInt16LE(unit.fadeOutMs ?? 0, at + 72);
    chunk.writeInt8(unit.fadeOutCurve ?? 0, at + 75);
    chunk.writeUInt16LE(unit.fadeInMs ?? 0, at + 76);
    chunk.writeInt8(unit.fadeInCurve ?? 0, at + 79);
  });
  return chunk;
}

test('audio file names decode from UTF-16LE before the tag', () => {
  const buffer = Buffer.concat([Buffer.alloc(64), auFl('kick.wav'), auFl('vocals #12.wav')]);
  const files = parseAudioFiles(buffer);
  assert.deepEqual(files.map((f) => f.fileName), ['kick.wav', 'vocals #12.wav']);
});

test('region definitions carry an oid, a length and a trim-in', () => {
  const buffer = Buffer.concat([
    Buffer.alloc(32),
    auRg({ name: 'kick.1', oid: 16, lengthSamples: 352_800, fileStartSamples: 88_200 }),
  ]);
  const [region] = parseAudioRegions(buffer);
  assert.equal(region.name, 'kick.1');
  assert.equal(region.oid, 16);
  assert.equal(region.lengthSamples, 352_800);
  assert.equal(region.fileStartSamples, 88_200);
});

test('arrangement units decode position, track and region ref', () => {
  // bar 0 == ARRANGE_TICK_ORIGIN, which is NOT the 38400 origin MIDI uses.
  const buffer = arrangeList([
    { bar: 0, trackNumber: 1, trackRef: 88, regionRef: 8 },
    { bar: 4, trackNumber: 2, trackRef: 92, regionRef: 16 },
    { bar: 16, trackNumber: 3, trackRef: 96, regionRef: 24 },
  ]);
  const units = parseArrangeUnits(buffer);
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((u) => u.positionTicks), [0, 4 * BAR_TICKS, 16 * BAR_TICKS]);
  assert.deepEqual(units.map((u) => u.trackNumber), [1, 2, 3]);
  assert.deepEqual(units.map((u) => u.regionRef), [8, 16, 24]);
});

test('the region oid is a pointer to its source file', () => {
  // AuRg +10 equals 4 x the AuFl index. Resolving by NAME instead picked the
  // wrong file for 102 regions in ~/Music/Logic: a take suffix like "X.10"
  // collided with a separate "X.1.wav", and the waveform came from a file of a
  // different length and ran out partway through the region.
  const buffer = Buffer.concat([
    auFl('take.wav'),
    auFl('take.1.wav'),
    auRg({ name: 'take.10', oid: 4, lengthSamples: 717_559 }),
    arrangeList([{ bar: 0, regionRef: 4 }]),
  ]);
  const files = parseAudioFiles(buffer);
  const [region] = placedAudioRegions(buffer);
  const file = files.find((f) => f.oid === region.fileOid);
  assert.equal(file.fileName, 'take.1.wav', 'the pointer wins over the name');
});

test('the ordinal picks the right record when several share an oid', () => {
  // Logic gives a region and its copies one oid; they differ in trim and
  // length. djpubichair.logicx has eleven records under oid 168, ten untrimmed
  // and one trimmed -- joining on the oid alone rendered the untrimmed sibling.
  const buffer = Buffer.concat([
    auRg({ name: 'full', oid: 168, ordinal: 0, lengthSamples: 717_559, fileStartSamples: 0 }),
    auRg({ name: 'trimmed', oid: 168, ordinal: 9, lengthSamples: 269_085, fileStartSamples: 89_695 }),
    arrangeList([
      { bar: 0, regionRef: 168, ordinal: 0 },
      { bar: 8, regionRef: 168, ordinal: 9 },
    ]),
  ]);
  const placed = placedAudioRegions(buffer);
  assert.equal(placed.length, 2);
  assert.deepEqual(placed.map((r) => r.name), ['full', 'trimmed']);
  assert.equal(placed[1].lengthSamples, 269_085);
  assert.equal(placed[1].fileStartSamples, 89_695);
});

test('an unknown ordinal falls back to the oid rather than dropping the region', () => {
  const buffer = Buffer.concat([
    auRg({ name: 'only', oid: 40, ordinal: 0, lengthSamples: 12_345 }),
    arrangeList([{ bar: 0, regionRef: 40, ordinal: 7 }]),
  ]);
  const placed = placedAudioRegions(buffer);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].lengthSamples, 12_345);
});

test('off-grid placements are found, with a sub-tick position', () => {
  // Bytes +2..3 hold a fraction of a tick for regions dropped between ticks.
  // Matching the marker as a u32 required them to be zero and silently dropped
  // every unsnapped region -- 1,402 of them across ~/Music/Logic.
  const buffer = arrangeList([
    { bar: 0, regionRef: 8 },
    { bar: 4, regionRef: 8, subtick: 0x8000 },
  ]);
  const units = parseArrangeUnits(buffer);
  assert.equal(units.length, 2, 'the off-grid unit is not dropped');
  assert.equal(units[1].positionTicks, 4 * BAR_TICKS + 0.5);
});

test('the flex flag is bit 7 of placement byte +48', () => {
  const buffer = arrangeList([
    { bar: 0, regionRef: 8, flex: true },
    { bar: 4, regionRef: 8, flex: false },
  ]);
  assert.deepEqual(parseArrangeUnits(buffer).map((u) => u.flex), [true, false]);
});

test('clip gain reads as a signed decibel byte', () => {
  const buffer = arrangeList([
    { bar: 0, regionRef: 8, gainDb: 5 },
    { bar: 4, regionRef: 8, gainDb: -3 },
    { bar: 8, regionRef: 8 },
  ]);
  assert.deepEqual(parseArrangeUnits(buffer).map((u) => u.gainDb), [5, -3, 0]);
});

test('region mute is bit 0 of +15, independent of the selection bit', () => {
  // re_probe12: the muted region reads 0x81; re_probe13's merely selected one 0x80.
  const buffer = arrangeList([
    { bar: 0, regionRef: 8 },
    { bar: 4, regionRef: 8, muted: true, selected: true },
    { bar: 8, regionRef: 8, selected: true },
  ]);
  assert.deepEqual(parseArrangeUnits(buffer).map((u) => u.muted), [false, true, false]);
});

test('region mute also decodes from the AuRg definition (+41 bit 1) as Logic Pro 11 stores it', () => {
  // djpubichair keeps region mute on the definition, not the placement: its
  // "kick 2" copies muted at bars 65-72 are byte-identical placements whose AuRg
  // records carry +41 bit 1. Two placements of two definitions, one muted there.
  const buffer = Buffer.concat([
    auRg({ name: 'plain', oid: 8, ordinal: 0 }),
    auRg({ name: 'muted-def', oid: 8, ordinal: 1, muted: true }),
    arrangeList([
      { bar: 0, trackNumber: 1, regionRef: 8, ordinal: 0 },
      { bar: 4, trackNumber: 1, regionRef: 8, ordinal: 1 },
    ]),
  ]);
  assert.deepEqual(placedAudioRegions(buffer).map((r) => [r.name, r.muted]), [
    ['plain', false],
    ['muted-def', true],
  ]);
});

test('region reverse is bit 5 of the +48 flags byte, independent of flex', () => {
  // djpubichair "crash": forward regions read 0x1c at +48, reversed ones 0x3c.
  const buffer = arrangeList([
    { bar: 0, regionRef: 8 },
    { bar: 4, regionRef: 8, reversed: true },
    { bar: 8, regionRef: 8, flex: true },
    { bar: 12, regionRef: 8, reversed: true, flex: true },
  ]);
  const units = parseArrangeUnits(buffer);
  assert.deepEqual(units.map((u) => u.reversed), [false, true, false, true]);
  // Reverse and flex live in the same byte but are independent bits.
  assert.deepEqual(units.map((u) => u.flex), [false, false, true, true]);
});

test('fades read as milliseconds with signed curves', () => {
  // re_probe13/14: a 1-bar fade-in and a 3-bar fade-out at 120 BPM, eased.
  const buffer = arrangeList([
    { bar: 0, regionRef: 8, fadeInMs: 1999, fadeInCurve: 98 },
    { bar: 16, regionRef: 8, fadeOutMs: 5995, fadeOutCurve: 99 },
    { bar: 24, regionRef: 8, fadeInMs: 2370, fadeInCurve: -43, fadeOutMs: 4590 },
  ]);
  assert.deepEqual(
    parseArrangeUnits(buffer).map((u) => [u.fadeInMs, u.fadeInCurve, u.fadeOutMs, u.fadeOutCurve]),
    [[1999, 98, 0, 0], [0, 0, 5995, 99], [2370, -43, 4590, 0]],
  );
});

test('a unit with an implausible track number is rejected', () => {
  const buffer = arrangeList([{ bar: 0, trackNumber: 200, regionRef: 8 }]);
  assert.deepEqual(parseArrangeUnits(buffer, 16), []);
});

test('a unit with an out-of-range position is rejected', () => {
  const buffer = arrangeList([{ bar: 0, regionRef: 8 }]);
  buffer.writeUInt32LE(0xfffffff0, 36 + 4);
  assert.deepEqual(parseArrangeUnits(buffer), []);
});

test('placement joins units to definitions on regionRef == oid', () => {
  const buffer = Buffer.concat([
    auRg({ name: 'drums', oid: 8, lengthSamples: 352_800 }),
    auRg({ name: 'bass', oid: 16, lengthSamples: 705_600 }),
    auRg({ name: 'never placed', oid: 99, lengthSamples: 100 }),
    arrangeList([
      { bar: 0, trackNumber: 1, trackRef: 88, regionRef: 8 },
      { bar: 4, trackNumber: 2, trackRef: 92, regionRef: 16 },
    ]),
  ]);
  const placed = placedAudioRegions(buffer);
  assert.equal(placed.length, 2, 'the unplaced pool entry is not returned');
  assert.deepEqual(placed[0], {
    name: 'drums',
    fileOid: 8,
    positionTicks: 0,
    lengthSamples: 352_800,
    fileStartSamples: 0,
    trackRef: 88,
    trackNumber: 1,
    gainDb: 0,
    flex: false,
    reversed: false,
    muted: false,
    transpose: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeInCurve: 0,
    fadeOutCurve: 0,
    timelineTicks: null,
  });
  assert.equal(placed[1].name, 'bass');
});

test('records are found even when they are not 4-byte aligned', () => {
  // solace.logicx's first unit sits at offset 889245. A scan that steps by 4
  // walks straight past every record in the file.
  const buffer = Buffer.concat([
    Buffer.alloc(3),
    auRg({ name: 'drums', oid: 8, lengthSamples: 88_200 }),
    Buffer.alloc(1),
    arrangeList([{ bar: 2, trackNumber: 1, trackRef: 88, regionRef: 8 }]),
  ]);
  const placed = placedAudioRegions(buffer);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].positionTicks, 2 * BAR_TICKS);
});

test('an interleaved foreign record costs one unit, not the whole list', () => {
  const buffer = arrangeList(
    [{ bar: 0, regionRef: 8 }, { bar: 4, regionRef: 16 }, { bar: 8, regionRef: 24 }],
    { markerFor: (i) => (i === 1 ? 0x136db : 0x24) },
  );
  assert.deepEqual(parseArrangeUnits(buffer).map((u) => u.regionRef), [8, 24]);
});

test('a record with an implausible name length is skipped, not thrown on', () => {
  const record = auRg({ name: 'ok', oid: 0 });
  record.writeUInt16LE(60_000, 110);
  assert.deepEqual(parseAudioRegions(record), []);
});
