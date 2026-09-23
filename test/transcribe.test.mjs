import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, UNPITCHED_PITCH } from '../.test-build/transcribe.mjs';

const RATE = 44100;

function tone(seconds, partials) {
  const data = new Float32Array(Math.round(seconds * RATE));
  for (const { pitch, amp } of partials) {
    const freq = 440 * 2 ** ((pitch - 69) / 12);
    for (let i = 0; i < data.length; i += 1) data[i] += amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  }
  return data;
}

function notes(result) {
  const list = [];
  for (let i = 0; i < result.length; i += 5) {
    list.push({ start: result[i], dur: result[i + 1], pitch: result[i + 2], velocity: result[i + 3], unpitched: result[i + 4] === 1 });
  }
  return list;
}

/** Pitched notes only: these tests are about the pitch pass. */
function pitchedNotes(result) {
  return notes(result).filter((n) => !n.unpitched);
}

test('a sustained A4 becomes one note at pitch 69 of about its length', () => {
  const found = pitchedNotes(transcribe([tone(2, [{ pitch: 69, amp: 0.5 }])], RATE));
  assert.equal(found.length, 1);
  assert.equal(found[0].pitch, 69);
  assert.ok(Math.abs(found[0].dur - 2) < 0.5, `duration ${found[0].dur}`);
  assert.ok(found[0].velocity > 100);
});

test('a chord still comes out one note at a time, never overlapping', () => {
  const found = pitchedNotes(transcribe([tone(1.5, [
    { pitch: 60, amp: 0.3 }, { pitch: 64, amp: 0.3 }, { pitch: 67, amp: 0.3 },
  ])], RATE));
  assert.ok(found.length >= 1);
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i].start >= found[i - 1].start + found[i - 1].dur - 1e-6, 'notes overlap');
  }
});

test('a tone with a weak fundamental and strong overtones lands on the fundamental', () => {
  const found = pitchedNotes(transcribe([tone(1.5, [
    { pitch: 57, amp: 0.15 }, { pitch: 69, amp: 0.4 }, { pitch: 76, amp: 0.3 }, { pitch: 81, amp: 0.2 },
  ])], RATE));
  assert.deepEqual([...new Set(found.map((n) => n.pitch))], [57]);
});

test('a melody becomes consecutive notes at its pitches', () => {
  const a = tone(0.8, [{ pitch: 64, amp: 0.4 }]);
  const b = tone(0.8, [{ pitch: 67, amp: 0.4 }]);
  const both = new Float32Array(a.length + b.length);
  both.set(a); both.set(b, a.length);
  const found = pitchedNotes(transcribe([both], RATE));
  const long = found.filter((n) => n.dur > 0.3).map((n) => n.pitch);
  assert.deepEqual(long, [64, 67]);
});

test('silence and too-short input produce nothing', () => {
  assert.equal(transcribe([new Float32Array(RATE)], RATE).length, 0);
  assert.equal(transcribe([new Float32Array(100)], RATE).length, 0);
});

/** Silence with kick-like thumps (a decaying 55 Hz sine) and hat-like hiss bursts at known times. */
function drumLoop(seconds, kicks, hats) {
  const data = new Float32Array(Math.round(seconds * RATE));
  let seed = 1;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1; };
  for (const at of kicks) {
    const from = Math.round(at * RATE);
    for (let i = 0; i < RATE * 0.25 && from + i < data.length; i += 1) {
      data[from + i] += 0.8 * Math.exp(-i / (RATE * 0.06)) * Math.sin((2 * Math.PI * 55 * i) / RATE);
    }
  }
  for (const at of hats) {
    const from = Math.round(at * RATE);
    let previous = 0;
    for (let i = 0; i < RATE * 0.05 && from + i < data.length; i += 1) {
      const white = noise();
      // First difference: a crude high-pass, so the burst is mostly hiss.
      data[from + i] += 0.4 * Math.exp(-i / (RATE * 0.012)) * (white - previous);
      previous = white;
    }
  }
  return data;
}

function near(times, target, tolerance = 0.03) {
  return times.some((t) => Math.abs(t - target) <= tolerance);
}

test('kicks and hats land as unpitched hits at their fixed band pitches', () => {
  const kicks = [0.5, 1.5, 2.5];
  const hats = [1.0, 2.0, 3.0];
  const found = notes(transcribe([drumLoop(3.5, kicks, hats)], RATE)).filter((n) => n.unpitched);
  const low = found.filter((n) => n.pitch === UNPITCHED_PITCH.low).map((n) => n.start);
  const high = found.filter((n) => n.pitch === UNPITCHED_PITCH.high).map((n) => n.start);
  for (const t of kicks) assert.ok(near(low, t), `no kick near ${t}: ${low}`);
  for (const t of hats) assert.ok(near(high, t), `no hat near ${t}: ${high}`);
  assert.ok(!high.some((t) => kicks.some((k) => Math.abs(t - k) < 0.03)), 'a kick read as a hat');
  const mid = found.filter((n) => n.pitch === UNPITCHED_PITCH.mid).map((n) => n.start);
  assert.ok(!mid.some((t) => kicks.some((k) => Math.abs(t - k) < 0.03)), 'a kick leaked into the mid band');
  assert.ok(!notes(transcribe([drumLoop(3.5, kicks, hats)], RATE)).some((n) => !n.unpitched && n.pitch < 52),
    'a kick smeared into a pitched bass note');
});

test('one-shot samples that hit at time zero, shorter than a pitch window, still land as hits', () => {
  const kick = notes(transcribe([drumLoop(0.25, [0], [])], RATE));
  assert.ok(kick.some((n) => n.unpitched && n.pitch === UNPITCHED_PITCH.low && n.start < 0.02), `no kick: ${JSON.stringify(kick)}`);
  const hat = notes(transcribe([drumLoop(0.11, [], [0])], RATE));
  assert.ok(hat.some((n) => n.unpitched && n.pitch === UNPITCHED_PITCH.high && n.start < 0.02), `no hat: ${JSON.stringify(hat)}`);
  // A one-shot's broadband attack trips several bands; it is still one hit.
  assert.equal(kick.filter((n) => n.unpitched).length, 1, `kick doubled: ${JSON.stringify(kick)}`);
  assert.equal(hat.filter((n) => n.unpitched).length, 1, `hat doubled: ${JSON.stringify(hat)}`);
});

test('a bass note starting after silence is pitched, not a kick', () => {
  const data = new Float32Array(RATE * 2);
  const bass = tone(1.5, [{ pitch: 45, amp: 0.5 }]);
  data.set(bass, RATE / 2);
  const found = notes(transcribe([data], RATE));
  assert.ok(found.some((n) => !n.unpitched && n.pitch === 45), 'bass note missing');
  assert.ok(!found.some((n) => n.unpitched && n.pitch === UNPITCHED_PITCH.low), 'bass onset doubled as a kick');
});
