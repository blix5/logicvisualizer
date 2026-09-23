import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMidiRegions, parseMidiPlacements, readRegionNotes } from '../.test-build/midiRegions.mjs';

const BAR = 3840;

test('notes are clipped to the region they belong to', { skip: (() => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(root) && 'no projects folder';
})() }, () => {
  // A note block is the region's full CONTENT and can outlast the region:
  // trimming a region's end leaves the trimmed-off notes in the block. Before
  // clipping, 194 of 2047 regions in the corpus drew notes past their end, by
  // up to 10 bars.
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  const projects = fs.readdirSync(root).filter((n) => n.endsWith('.logicx'));
  let checked = 0;
  let overrun = 0;
  for (const name of projects) {
    const file = path.join(root, name, 'Alternatives/000/ProjectData');
    if (!fs.existsSync(file)) continue;
    let regions;
    try { regions = parseMidiRegions(fs.readFileSync(file), 200); } catch { continue; }
    for (const region of regions) {
      if (!region.notes.length) continue;
      checked += 1;
      for (const note of region.notes) {
        // A note may start early, but one that has ended by the region's
        // start is hidden by a left-edge trim and must not be drawn.
        assert.ok(note.startTicks + note.durationTicks > 0, `${region.name}: note ends before its region`);
        if (note.startTicks + note.durationTicks > region.lengthTicks) overrun += 1;
      }
    }
  }
  assert.ok(checked > 0, 'found MIDI regions to check');
  assert.equal(overrun, 0, 'no note extends past its region');
});

test('placements are found despite not being 4-byte aligned', { skip: (() => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(root, 'mega_test.logicx')) && 'mega_test.logicx not found';
})() }, () => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  const buffer = fs.readFileSync(path.join(root, 'mega_test.logicx', 'Alternatives/000/ProjectData'));
  const placements = parseMidiPlacements(buffer, 8);
  assert.ok(placements.length > 200, `found placements (${placements.length})`);

  // Track 1's regions sit on a 4-bar grid. Taking positions from the region
  // cells instead put them every 2 bars with 4-bar lengths -- a 50% overlap,
  // which is the bug this record type fixes.
  const positions = [...new Set(placements
    .filter((p) => p.trackNumber === 1)
    .map((p) => p.positionTicks))].sort((a, b) => a - b);
  assert.equal(positions[0], 0, 'first region at bar 1');
  const gaps = positions.slice(1, 12).map((p, i) => p - positions[i]);
  assert.ok(gaps.every((g) => g % (4 * BAR) === 0), `gaps are whole 4-bar steps (${gaps.join(',')})`);
});

/** A qSvE note block holding the given 32-byte note records, as readRegionNotes expects it. */
function noteBlock(records) {
  const buffer = Buffer.alloc(36 + records.length * 32 + 16);
  buffer.writeUInt32LE(records.length * 32 + 16, 28);
  records.forEach(({ status, raw, pitch, velocity, duration }, i) => {
    const at = 36 + i * 32;
    buffer.writeUInt8(status, at);
    buffer.writeUInt32LE(raw, at + 4);
    buffer.writeUInt8(velocity, at + 11);
    buffer.writeUInt8(pitch, at + 12);
    buffer.writeUInt8(0x89, at + 23);
    buffer.writeUInt32LE(duration, at + 28);
  });
  buffer.writeUInt8(0xf1, 36 + records.length * 32);
  return buffer;
}

test('a note stored below the origin starts before its region rather than bars later', () => {
  // Positions are signed about 38400. Read as unsigned ticks from 0, this
  // note played 13 ticks early landed at tick 38387 -- past the end of most
  // regions, so it was clipped away and the region lost its first note.
  const notes = readRegionNotes(noteBlock([
    { status: 0x90, raw: 38400 - 13, pitch: 60, velocity: 100, duration: 960 },
    { status: 0x90, raw: 38400 + 960, pitch: 62, velocity: 100, duration: 960 },
  ]), 0);
  assert.deepEqual(notes.map((n) => n.startTicks), [-13, 960]);
});

test('notes on any MIDI channel are read, not only channel 1', () => {
  // mega_test_full's Bass Player region stores its notes as 0x98 (channel 9).
  const notes = readRegionNotes(noteBlock([
    { status: 0x98, raw: 38400 + 6, pitch: 40, velocity: 90, duration: 480 },
    { status: 0x90, raw: 38400 + 960, pitch: 43, velocity: 90, duration: 480 },
  ]), 0);
  assert.deepEqual(notes.map((n) => n.pitch), [40, 43]);
});

test('early-played first notes survive and left-trimmed notes do not', { skip: (() => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(root, 'synth thingy edit.logicx')) && 'synth thingy edit.logicx not found';
})() }, () => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  const buffer = fs.readFileSync(path.join(root, 'synth thingy edit.logicx', 'Alternatives/000/ProjectData'));
  const regions = parseMidiRegions(buffer, 200);

  // The bar-72.125 Hazy Plucked Synth is the bar-73.75 copy with its left edge
  // trimmed 39840 ticks in. Of the 16 notes that trim hides, only the one
  // still sounding at the region's start remains; the three after it are the
  // region's own.
  const trimmed = regions.find((r) => r.name.startsWith('Hazy') && Math.abs(r.positionTicks - 71.125 * BAR) < 1);
  assert.ok(trimmed, 'found the trimmed region');
  assert.deepEqual(trimmed.notes.map((n) => n.startTicks), [-2400, 480, 623, 1920]);

  // The 808's first note starts a bar ahead of each region and holds into it.
  const bass = regions.filter((r) => r.name === 'Solid 808 Bass');
  assert.ok(bass.some((r) => r.notes[0]?.startTicks === -BAR), 'an 808 region keeps its early first note');
});
