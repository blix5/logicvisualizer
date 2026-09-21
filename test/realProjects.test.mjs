import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProjectModel } from '../.test-build/buildProject.mjs';
import { buildTempoMap, secondsToBeats } from '../.test-build/timebase.mjs';

// Gated on an env var with a sensible default rather than a hardcoded absolute
// path, so this suite actually runs on a machine that has projects.
const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
const projects = fs.existsSync(root)
  ? fs.readdirSync(root).filter((n) => n.endsWith('.logicx')).sort()
  : [];

test('real projects parse and satisfy the model invariants', { skip: projects.length === 0 && 'no .logicx projects found' }, async (t) => {
  for (const name of projects) {
    await t.test(name, () => {
      const started = Date.now();
      const model = buildProjectModel(path.join(root, name));
      assert.ok(Date.now() - started < 8000, 'parse finished in reasonable time');
      assert.equal(model.schemaVersion, 1);
      assert.ok(model.baseBpm >= 20 && model.baseBpm <= 400, `tempo ${model.baseBpm} in range`);
      assert.ok(model.sampleRate > 0);

      for (const event of model.tempoEvents) {
        assert.ok(Number.isFinite(event.beat) && event.bpm >= 1 && event.bpm <= 999);
      }

      let previous = -Infinity;
      for (const region of model.regions) {
        assert.ok(Number.isFinite(region.startSeconds), `${region.name} has finite start`);
        assert.ok(region.endSeconds >= region.startSeconds, `${region.name} does not end before it starts`);
        assert.ok(region.startSeconds >= previous, 'regions are sorted by start time');
        previous = region.startSeconds;
        assert.ok(model.tracks.some((t2) => t2.id === region.trackId), `${region.name} lands on a real track`);
      }

      for (const file of model.audioFiles) {
        if (file.absolutePath) assert.equal(typeof file.exists, 'boolean');
      }

      // MIDI regions must not overlap on a lane. They used to, badly: taking
      // position from the region cells rather than the arrangement placements
      // put mega_test's regions every 2 bars with 4-bar lengths.
      const lanes = new Map();
      for (const region of model.regions) {
        if (region.kind !== 'midi') continue;
        const lane = lanes.get(region.trackId);
        if (lane) lane.push(region); else lanes.set(region.trackId, [region]);
      }
      for (const lane of lanes.values()) {
        lane.sort((a, b) => a.startSeconds - b.startSeconds);
        for (let i = 1; i < lane.length; i += 1) {
          assert.ok(
            lane[i - 1].endSeconds - lane[i].startSeconds <= 0.01,
            `${name}: MIDI regions overlap on one lane`,
          );
        }
      }
    });
  }
});

test('flex-on regions are stretched to their musical length', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // djpubichair's "key" track holds 28 copies of one loop. Flex-on copies must
  // be exactly 2 bars; any flex-off copy keeps its native 2.1288. The count of
  // each is NOT asserted: this is a live project its owner edits, and the flex
  // state of individual regions has changed between saves.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const key = model.tracks.find((t) => t.name === 'key');
  assert.ok(key, 'found the key track');
  const regions = model.regions.filter((r) => r.trackId === key.id);
  assert.equal(regions.length, 28);

  // Bars are measured through the tempo map, not the base tempo: this project
  // has tempo changes, so a fixed 118 BPM bar length would be wrong later on.
  const tempo = buildTempoMap(model.tempoEvents, model.baseBpm);
  const bars = (r) => (secondsToBeats(tempo, r.endSeconds) - secondsToBeats(tempo, r.startSeconds)) / 4;

  let flexOn = 0;
  for (const r of regions) {
    if (r.flex) {
      flexOn += 1;
      assert.ok(Math.abs(bars(r) - 2) < 0.001, `${r.name} (flex on) is exactly 2 bars, got ${bars(r).toFixed(4)}`);
      assert.ok(r.sourceRate > 1, `${r.name}: its audio is sped up to fit`);
    } else {
      assert.ok(Math.abs(bars(r) - 2.1288) < 0.001, `${r.name} (flex off) keeps its native length`);
      assert.equal(r.sourceRate, 1);
    }
  }
  assert.ok(flexOn > 0, 'at least one flex-on region to check');
});

test('tempo changes and curves are decoded', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // 118 BPM to bar 97 beat 4, easing to 125 at bar 100 beat 4, then 134 at bar
  // 103 beat 4. Tempo records are interleaved with 16-byte meta chunks, so a
  // fixed-stride walk found only the first event.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const events = model.tempoEvents;
  assert.ok(events.length > 10, `the curve's intermediate points are present (${events.length})`);
  const at = (bar, beat) => {
    const target = (bar - 1) * 4 + (beat - 1);
    return events.reduce((a, b) => (Math.abs(b.beat - target) < Math.abs(a.beat - target) ? b : a));
  };
  assert.equal(events[0].bpm, 118);
  assert.equal(at(97, 4).bpm, 118);
  assert.equal(at(100, 4).bpm, 125);
  assert.equal(at(103, 4).bpm, 134);
  // The ramp between them eases rather than stepping straight to the target.
  const ramp = events.filter((e) => e.beat > (96 * 4 + 3) && e.beat < (99 * 4 + 3));
  assert.ok(ramp.length > 5, 'intermediate points between anchors');
  assert.ok(ramp.every((e, i) => i === 0 || e.bpm >= ramp[i - 1].bpm), 'monotonic ramp');
});
