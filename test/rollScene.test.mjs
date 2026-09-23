import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollScene, firstVisibleRollNote } from '../.test-build/rollScene.mjs';

// One beat = 960 ticks = 0.5 s at 120 BPM, so a 4-beat region spans 2 s.
const PPQ = 960;

function track(id, index, muted = false) {
  return { id, arrangeIndex: index, name: id, kind: 'midi', color: `hsl(${index * 40} 70% 60%)`,
    colorSource: 'project', trackRef: index, muted };
}

function midi(id, trackId, startSeconds, notes) {
  const flat = new Int32Array(notes.flat());
  const pitches = notes.map((n) => n[2]);
  return {
    kind: 'midi', id, trackId, name: id, startBeat: startSeconds * 2, lengthBeats: 4,
    startSeconds, endSeconds: startSeconds + 2, notes: flat, noteCount: notes.length,
    pitchMin: Math.min(...pitches), pitchMax: Math.max(...pitches),
  };
}

function project(tracks, regions) {
  return { tracks, regions, audioFiles: [], endSeconds: 60 };
}

test('notes from several regions merge into one start-sorted array per track', () => {
  const scene = buildRollScene(project([track('a', 0)], [
    midi('r2', 'a', 4, [[0, PPQ, 60, 100]]),
    midi('r1', 'a', 0, [[PPQ * 2, PPQ, 64, 100], [0, PPQ, 62, 100]]),
  ]));
  assert.equal(scene.tracks.length, 1);
  const t = scene.tracks[0];
  assert.equal(t.count, 3);
  assert.deepEqual(Array.from(t.start), [0, 1, 4]);
  assert.deepEqual(Array.from(t.pitch), [62, 64, 60]);
  assert.ok(Math.abs(t.maxDurationSeconds - 0.5) < 1e-6);
});

test('muted tracks contribute neither notes nor pitch range', () => {
  const scene = buildRollScene(project([track('a', 0), track('b', 1, true)], [
    midi('ra', 'a', 0, [[0, PPQ, 60, 100]]),
    midi('rb', 'b', 0, [[0, PPQ, 20, 100]]),
  ]));
  assert.deepEqual(scene.tracks.map((t) => t.trackId), ['a']);
  assert.ok(scene.pitchLow > 20);
});

test('the pitch range is padded and never narrower than two octaves', () => {
  const narrow = buildRollScene(project([track('a', 0)], [midi('r', 'a', 0, [[0, PPQ, 60, 100]])]));
  assert.equal(narrow.pitchHigh - narrow.pitchLow + 1, 24);
  assert.ok(narrow.pitchLow <= 58 && narrow.pitchHigh >= 62);

  const wide = buildRollScene(project([track('a', 0)], [
    midi('r', 'a', 0, [[0, PPQ, 30, 100], [0, PPQ, 90, 100]]),
  ]));
  assert.equal(wide.pitchLow, 28);
  assert.equal(wide.pitchHigh, 92);

  const floor = buildRollScene(project([track('a', 0)], [midi('r', 'a', 0, [[0, PPQ, 1, 100]])]));
  assert.equal(floor.pitchLow, 0);
  assert.equal(floor.pitchHigh, 23);
});

test('culling backs off far enough to keep a long note spanning the window start', () => {
  const scene = buildRollScene(project([track('a', 0)], [
    // A 3.5-beat note from t=0, then short notes after it.
    midi('r', 'a', 0, [[0, PPQ * 3.5, 60, 100], [PPQ * 2, 100, 62, 100], [PPQ * 3, 100, 64, 100]]),
  ]));
  const t = scene.tracks[0];
  // At t=1.5 s the long note (0..1.75 s) is still sounding and must be included.
  assert.equal(firstVisibleRollNote(t, 1.5), 0);
});

function audioRegion(id, trackId, startSeconds, endSeconds, extra = {}) {
  return { kind: 'audio', id, trackId, name: id, startBeat: 0, lengthBeats: 0, startSeconds, endSeconds,
    audioFileId: 'f1', fileStartSeconds: 0, gainDb: 0, flex: false, sourceRate: 1, lengthApproximate: false, ...extra };
}

test('transcribed notes map through trim-in and flex rate, and clip to the region', () => {
  // Source notes at 1 s (pitch 60) and 3 s (pitch 62), each 1 s long.
  const notes = new Float32Array([1, 1, 60, 100, 0, 3, 1, 62, 100, 0]);
  const scene = buildRollScene(project([track('a', 0)], [
    // Region starts at 10 s, trims 0.5 s in, plays source at double speed, lasts 1.5 s.
    audioRegion('r', 'a', 10, 11.5, { fileStartSeconds: 0.5, sourceRate: 2 }),
  ]), (id) => (id === 'f1' ? notes : null));
  const converted = scene.tracks.find((t) => t.converted);
  assert.ok(converted);
  assert.equal(converted.count, 2);
  // (1 - 0.5) / 2 = 0.25 s in, lasting 0.5 s.
  assert.ok(Math.abs(converted.start[0] - 10.25) < 1e-4);
  assert.ok(Math.abs(converted.duration[0] - 0.5) < 1e-4);
  // (3 - 0.5) / 2 = 1.25 s in; clipped at the region end, 0.25 s left.
  assert.ok(Math.abs(converted.start[1] - 11.25) < 1e-4);
  assert.ok(Math.abs(converted.duration[1] - 0.25) < 1e-4);
  // Each note remembers its region, so the renderer can draw that stretch of its waveform.
  assert.equal(converted.sources[converted.source[1]].id, 'r');
});

test('with MIDI present, converted notes outside its range are dropped; muted audio is ignored', () => {
  const notes = new Float32Array([0, 1, 20, 100, 0, 0, 1, 61, 100, 0]);
  const scene = buildRollScene(project([track('a', 0), track('b', 1), track('c', 2, true)], [
    midi('m', 'a', 0, [[0, PPQ, 60, 100]]),
    audioRegion('r', 'b', 0, 2),
    audioRegion('rm', 'c', 0, 2),
  ]), () => notes);
  const converted = scene.tracks.filter((t) => t.converted);
  assert.deepEqual(converted.map((t) => t.trackId), ['b']);
  assert.deepEqual(Array.from(converted[0].pitch), [61]);
  assert.ok(scene.pitchLow > 20);
});

test('unpitched hits are clamped into the roll rather than dropped', () => {
  // A kick at pitch 35 and a hat at 120, against MIDI that keeps the roll near middle C.
  const notes = new Float32Array([0, 0.1, 35, 100, 1, 0.5, 0.1, 120, 100, 1]);
  const scene = buildRollScene(project([track('a', 0), track('b', 1)], [
    midi('m', 'a', 0, [[0, PPQ, 60, 100]]),
    audioRegion('r', 'b', 0, 2),
  ]), () => notes);
  const converted = scene.tracks.find((t) => t.converted);
  assert.deepEqual(Array.from(converted.pitch), [scene.pitchLow, scene.pitchHigh]);
});

test('muted regions are left out of the roll, MIDI and audio alike', () => {
  const scene = buildRollScene(project([track('a', 0), track('b', 1)], [
    midi('m1', 'a', 0, [[0, PPQ, 60, 100]]),
    { ...midi('m2', 'a', 4, [[0, PPQ, 62, 100]]), muted: true },
    { ...audioRegion('r', 'b', 0, 2), muted: true },
  ]), () => new Float32Array([0, 1, 61, 100, 0]));
  assert.deepEqual(scene.tracks.map((t) => [t.trackId, t.count]), [['a', 1]]);
  assert.equal(scene.audio.length, 0);
});

test('volume automation dims notes and silences them at -inf', () => {
  // Unity until 2 s, then a straight ramp to -inf at 4 s.
  const volume = { seconds: new Float64Array([0, 2, 4]), fader: new Float32Array([90, 90, 0]) };
  const scene = buildRollScene(project([{ ...track('a', 0), volume }], [
    midi('r1', 'a', 0, [[0, PPQ, 60, 100]]),
    midi('r2', 'a', 2, [[PPQ * 2, PPQ, 62, 100], [PPQ * 4, PPQ, 64, 100]]),
  ]));
  // At 0 s unity, at 3 s halfway down, at 4 s silent.
  assert.deepEqual(Array.from(scene.tracks[0].level), [8, 4, 0]);
  const unautomated = buildRollScene(project([track('a', 0)], [midi('r1', 'a', 0, [[0, PPQ, 60, 100]])]));
  assert.deepEqual(Array.from(unautomated.tracks[0].level), [8]);
});
