import test from 'node:test';
import assert from 'node:assert/strict';
import { OnsetDetector, ONSET_COOLDOWN_MS } from '../.test-build/onset.mjs';
import {
  applyPreset, DEFAULT_VISUALS, sanitizeVisuals, snapshotPreset,
} from '../.test-build/visualSettings.mjs';
import { BUILT_IN_PRESETS } from '../.test-build/visualPresets.mjs';
import { LAYER_CATALOG } from '../.test-build/visualCatalog.mjs';

const FRAME_MS = 1000 / 60;

/** Runs `frames` frames of flux through a fresh detector; returns the frames that fired. */
function run(fluxAt, frames) {
  const detector = new OnsetDetector();
  const hits = [];
  for (let f = 0; f < frames; f += 1) {
    if (detector.push(fluxAt(f), f * FRAME_MS) > 0) hits.push(f);
  }
  return hits;
}

test('a steady signal never fires', () => {
  assert.deepEqual(run(() => 0.02, 600), []);
  assert.deepEqual(run(() => 0, 600), []);
});

test('low-level jitter below the floor never fires', () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  assert.deepEqual(run(() => random() * 0.008, 600), []);
});

test('periodic bursts fire once each, on the burst frame', () => {
  // A kick every 30 frames (120 BPM at 60 fps), whose transient is smeared
  // over three frames as the analyser's smoothing does.
  const flux = (f) => {
    const phase = f % 30;
    if (phase === 0) return 0.2;
    if (phase === 1) return 0.12;
    if (phase === 2) return 0.06;
    return 0.004;
  };
  const hits = run(flux, 300);
  const expected = Array.from({ length: 10 }, (_, i) => i * 30).filter((f) => f > 0);
  // The very first burst may land before there is any history; every later one fires exactly once.
  assert.deepEqual(hits.filter((f) => f > 0), expected);
});

test('the cooldown keeps a burst from firing twice', () => {
  const detector = new OnsetDetector();
  for (let f = 0; f < 60; f += 1) detector.push(0.003, f * FRAME_MS);
  const t = 60 * FRAME_MS;
  assert.ok(detector.push(0.3, t) > 0);
  assert.equal(detector.push(0.6, t + ONSET_COOLDOWN_MS - 1), 0);
  assert.ok(detector.push(0.9, t + ONSET_COOLDOWN_MS + 1) > 0);
});

test('strength is within 0..1 and grows with the jump', () => {
  const strength = (peak) => {
    const detector = new OnsetDetector();
    for (let f = 0; f < 60; f += 1) detector.push(0.003, f * FRAME_MS);
    return detector.push(peak, 60 * FRAME_MS);
  };
  const soft = strength(0.03);
  const hard = strength(0.5);
  assert.ok(soft > 0 && soft <= 1);
  assert.ok(hard > soft && hard <= 1);
});

test('defaults list every layer each view can show, all off', () => {
  for (const view of ['roll', 'arrange']) {
    const ids = DEFAULT_VISUALS[view].map((layer) => layer.id);
    const expected = LAYER_CATALOG.filter((meta) => meta.views.includes(view)).map((meta) => meta.id);
    assert.deepEqual(ids, expected, view);
    assert.ok(DEFAULT_VISUALS[view].every((layer) => !layer.enabled));
  }
  assert.ok(!DEFAULT_VISUALS.arrange.some((layer) => layer.id === 'pitch-spectrum'));
});

test('sanitize drops junk and unknown layers, clamps numbers, and fills in the rest', () => {
  const clean = sanitizeVisuals({
    roll: [
      { id: 'nope', enabled: true },
      'garbage',
      { id: 'radial-ring', enabled: true, opacity: 7, intensity: -3, placement: 'sideways', params: { bars: 9999, spin: 'fast', bogus: 1 } },
      { id: 'radial-ring', enabled: false },
    ],
    arrange: [{ id: 'pitch-spectrum', enabled: true }],
    preset: 42,
    userPresets: [{ id: 'u1', name: 'Mine', roll: [{ id: 'aurora' }, { id: 'nope' }] }, { name: 'no id' }],
  });
  const ring = clean.roll[0];
  assert.equal(ring.id, 'radial-ring');
  assert.equal(ring.enabled, true);
  assert.equal(ring.opacity, 1);
  assert.equal(ring.intensity, 0);
  assert.equal(ring.placement, 'front');
  assert.equal(ring.params.bars, 160);
  assert.equal(ring.params.spin, 0.25);
  assert.equal('bogus' in ring.params, false);
  assert.equal(clean.roll.filter((layer) => layer.id === 'radial-ring').length, 1);
  assert.equal(clean.roll.length, DEFAULT_VISUALS.roll.length);
  assert.ok(!clean.arrange.some((layer) => layer.id === 'pitch-spectrum'));
  assert.equal(clean.preset, null);
  assert.equal(clean.userPresets.length, 1);
  assert.deepEqual(clean.userPresets[0].roll.map((layer) => layer.id), ['aurora']);
  assert.deepEqual(sanitizeVisuals(null), DEFAULT_VISUALS);
  assert.deepEqual(sanitizeVisuals('x'), DEFAULT_VISUALS);
});

test('every built-in preset names only real layers for its views', () => {
  for (const preset of BUILT_IN_PRESETS) {
    for (const view of ['roll', 'arrange']) {
      for (const entry of preset[view]) {
        const meta = LAYER_CATALOG.find((m) => m.id === entry.id);
        assert.ok(meta, `${preset.name}: ${entry.id}`);
        assert.ok(meta.views.includes(view), `${preset.name}: ${entry.id} in ${view}`);
      }
    }
  }
});

test('applying a preset turns on exactly its layers, in its order, with its overrides', () => {
  const club = BUILT_IN_PRESETS.find((p) => p.id === 'builtin:club');
  const applied = applyPreset(DEFAULT_VISUALS, club);
  assert.equal(applied.preset, club.id);
  const on = applied.roll.filter((layer) => layer.enabled).map((layer) => layer.id);
  assert.deepEqual(on, club.roll.map((layer) => layer.id));
  assert.equal(applied.roll.find((layer) => layer.id === 'starfield').intensity, 1.3);
  assert.equal(applied.roll.find((layer) => layer.id === 'flash').params.style, 'vignette');
  assert.equal(applied.roll.length, DEFAULT_VISUALS.roll.length);
});

test('a saved preset reapplies to the same settings', () => {
  const start = applyPreset(DEFAULT_VISUALS, BUILT_IN_PRESETS.find((p) => p.id === 'builtin:mandala'));
  const tweaked = sanitizeVisuals({
    ...start,
    roll: start.roll.map((layer) => (layer.id === 'radial-ring' ? { ...layer, opacity: 0.4, params: { ...layer.params, bars: 48 } } : layer)),
  });
  const saved = snapshotPreset(tweaked, 'user:x', 'Mine');
  const round = applyPreset(sanitizeVisuals({ ...DEFAULT_VISUALS, userPresets: [saved] }), saved);
  assert.deepEqual(round.roll, tweaked.roll);
  assert.deepEqual(round.arrange, tweaked.arrange);
  // And survives storage.
  const stored = sanitizeVisuals(JSON.parse(JSON.stringify({ ...round, userPresets: [saved] })));
  assert.deepEqual(stored.userPresets[0], saved);
});
