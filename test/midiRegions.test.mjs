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
        assert.ok(note.startTicks >= 0, `${region.name}: note starts before its region`);
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
