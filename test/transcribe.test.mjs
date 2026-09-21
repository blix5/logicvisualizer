import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from '../.test-build/transcribe.mjs';

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
  for (let i = 0; i < result.length; i += 4) {
    list.push({ start: result[i], dur: result[i + 1], pitch: result[i + 2], velocity: result[i + 3] });
  }
  return list;
}

test('a sustained A4 becomes one note at pitch 69 of about its length', () => {
  const found = notes(transcribe([tone(2, [{ pitch: 69, amp: 0.5 }])], RATE));
  assert.equal(found.length, 1);
  assert.equal(found[0].pitch, 69);
  assert.ok(Math.abs(found[0].dur - 2) < 0.5, `duration ${found[0].dur}`);
  assert.ok(found[0].velocity > 100);
});

test('a chord still comes out one note at a time, never overlapping', () => {
  const found = notes(transcribe([tone(1.5, [
    { pitch: 60, amp: 0.3 }, { pitch: 64, amp: 0.3 }, { pitch: 67, amp: 0.3 },
  ])], RATE));
  assert.ok(found.length >= 1);
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i].start >= found[i - 1].start + found[i - 1].dur - 1e-6, 'notes overlap');
  }
});

test('a tone with a weak fundamental and strong overtones lands on the fundamental', () => {
  const found = notes(transcribe([tone(1.5, [
    { pitch: 57, amp: 0.15 }, { pitch: 69, amp: 0.4 }, { pitch: 76, amp: 0.3 }, { pitch: 81, amp: 0.2 },
  ])], RATE));
  assert.deepEqual([...new Set(found.map((n) => n.pitch))], [57]);
});

test('a melody becomes consecutive notes at its pitches', () => {
  const a = tone(0.8, [{ pitch: 64, amp: 0.4 }]);
  const b = tone(0.8, [{ pitch: 67, amp: 0.4 }]);
  const both = new Float32Array(a.length + b.length);
  both.set(a); both.set(b, a.length);
  const found = notes(transcribe([both], RATE));
  const long = found.filter((n) => n.dur > 0.3).map((n) => n.pitch);
  assert.deepEqual(long, [64, 67]);
});

test('silence and too-short input produce nothing', () => {
  assert.equal(transcribe([new Float32Array(RATE)], RATE).length, 0);
  assert.equal(transcribe([new Float32Array(100)], RATE).length, 0);
});
