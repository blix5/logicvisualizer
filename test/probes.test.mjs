import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placedAudioRegions } from '../.test-build/logicAudio.mjs';

// re_probe1..6 are controlled projects built in Logic to isolate one variable
// each. They are exact ground truth for the arrangement format and are the
// regression test that matters most: breaking these means the format
// understanding is wrong, not merely the code.
//
// probe5 is the one that settled the unit -> region join. In probes 1-4 every
// region sat on its own track, which made a per-track field and a per-region
// field indistinguishable; probe5 puts three regions of different lengths on
// ONE track, so only a genuine region pointer can produce 4/8/6 bars.
const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
const BAR = 3840;
const BAR_SAMPLES = 88_200; // one bar at 120 BPM, 44.1 kHz

function read(name) {
  const file = path.join(root, `${name}.logicx`, 'Alternatives/000/ProjectData');
  return fs.existsSync(file) ? placedAudioRegions(fs.readFileSync(file)) : null;
}

const describe = (regions) => regions
  .map((r) => ({ bar: r.positionTicks / BAR + 1, track: r.trackNumber, bars: r.lengthSamples / BAR_SAMPLES }))
  .sort((a, b) => a.bar - b.bar || a.track - b.track);

const describeTrim = (regions) => regions
  .map((r) => ({
    bar: r.positionTicks / BAR + 1,
    bars: r.lengthSamples / BAR_SAMPLES,
    trimIn: r.fileStartSamples / BAR_SAMPLES,
  }))
  .sort((a, b) => a.bar - b.bar);

const probe1 = read('re_probe1');

test('probe projects decode exactly as they were built', { skip: probe1 === null && 're_probe*.logicx not found' }, async (t) => {
  await t.test('probe1: bars 1/5/17 on tracks 1/2/3, 4/8/2 bars long', () => {
    assert.deepEqual(describe(probe1), [
      { bar: 1, track: 1, bars: 4 },
      { bar: 5, track: 2, bars: 8 },
      { bar: 17, track: 3, bars: 2 },
    ]);
  });

  await t.test('probe2: clip 2 moved one bar right', () => {
    assert.deepEqual(describe(read('re_probe2')), [
      { bar: 1, track: 1, bars: 4 },
      { bar: 6, track: 2, bars: 8 },
      { bar: 17, track: 3, bars: 2 },
    ]);
  });

  await t.test('probe3: clip 3 lengthened from 2 to 4 bars, position unchanged', () => {
    assert.deepEqual(describe(read('re_probe3')), [
      { bar: 1, track: 1, bars: 4 },
      { bar: 6, track: 2, bars: 8 },
      { bar: 17, track: 3, bars: 4 },
    ]);
  });

  await t.test('probe4: clip 1 moved to track 3', () => {
    assert.deepEqual(describe(read('re_probe4')), [
      { bar: 1, track: 3, bars: 4 },
      { bar: 6, track: 2, bars: 8 },
      { bar: 17, track: 3, bars: 4 },
    ]);
  });

  await t.test('probe5: three DIFFERENT lengths on ONE track resolve individually', () => {
    assert.deepEqual(describe(read('re_probe5')), [
      { bar: 1, track: 1, bars: 4 },
      { bar: 6, track: 1, bars: 8 },
      { bar: 17, track: 1, bars: 6 },
    ]);
  });

  await t.test('probe7: trimming the start moves position, length and trim-in together', () => {
    // probe5 with 1, 2 and 3 bars cut off the FRONT of the three regions. Each
    // one must move later, shorten, and start further into its source file by
    // the same amount -- which is what pins AuRg +42 as the trim-in.
    assert.deepEqual(describeTrim(read('re_probe7')), [
      { bar: 2, bars: 3, trimIn: 1 },
      { bar: 8, bars: 6, trimIn: 2 },
      { bar: 20, bars: 3, trimIn: 3 },
    ]);
    // probe5, its parent, is untrimmed.
    assert.deepEqual(describeTrim(read('re_probe5')).map((r) => r.trimIn), [0, 0, 0]);
  });

  await t.test('probe10: clip gain is a signed dB byte on the placement record', () => {
    const gains = (name) => read(name)
      .slice()
      .sort((a, b) => a.positionTicks - b.positionTicks)
      .map((r) => r.gainDb);
    assert.deepEqual(gains('re_probe9'), [0, 0, 0], 'its parent has no clip gain');
    assert.deepEqual(gains('re_probe10'), [5, 0, -3]);
  });

  await t.test('probe6: a dozen regions across four tracks all resolve', () => {
    const placed = read('re_probe6');
    assert.equal(placed.length, 13);
    assert.deepEqual([...new Set(placed.map((r) => r.trackNumber))].sort(), [1, 2, 3, 4]);
    // Every unit joined to a definition, and every length is a real duration.
    for (const region of placed) {
      assert.ok(region.lengthSamples > 0, `${region.name} has a length`);
      assert.ok(region.name.length > 0);
    }
    // Distinct region refs, i.e. the join is not collapsing onto one record.
    assert.ok(new Set(placed.map((r) => r.name)).size >= 10);
  });
});
