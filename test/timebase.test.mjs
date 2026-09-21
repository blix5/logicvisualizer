import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTempoMap, beatsToSeconds, secondsToBeats, bpmAtBeat, buildBarGrid, ticksToBeats,
} from '../.test-build/timebase.mjs';

test('ticksToBeats honours the stated origin', () => {
  assert.equal(ticksToBeats(38400, 'absolute'), 0);
  assert.equal(ticksToBeats(39360, 'absolute'), 1);
  // A bar1-origin value must NOT have 38400 subtracted, even when it is large:
  // that is the bug a magnitude guess introduces past bar 11.
  assert.equal(ticksToBeats(38400, 'bar1'), 40);
});

test('constant tempo maps beats to seconds linearly', () => {
  const map = buildTempoMap([], 120);
  assert.equal(beatsToSeconds(map, 0), 0);
  assert.equal(beatsToSeconds(map, 4), 2);
  assert.equal(secondsToBeats(map, 2), 4);
});

test('a tempo change accumulates correctly across segments', () => {
  // 120 BPM for 16 beats (8s), then 60 BPM. Beat 32 == 8 + 16 == 24s.
  const map = buildTempoMap([{ beat: 0, bpm: 120 }, { beat: 16, bpm: 60 }], 120);
  assert.equal(beatsToSeconds(map, 16), 8);
  assert.equal(beatsToSeconds(map, 32), 24);
  assert.equal(bpmAtBeat(map, 20), 60);
  assert.equal(bpmAtBeat(map, 15), 120);
});

test('beats <-> seconds round-trip over a random multi-segment map', () => {
  const events = [];
  let beat = 0;
  for (let i = 0; i < 25; i += 1) {
    events.push({ beat, bpm: 40 + Math.random() * 180 });
    beat += 1 + Math.random() * 30;
  }
  const map = buildTempoMap(events, 120);
  for (let i = 0; i < 500; i += 1) {
    const probe = Math.random() * beat;
    assert.ok(Math.abs(secondsToBeats(map, beatsToSeconds(map, probe)) - probe) < 1e-9);
  }
});

test('seconds increase monotonically with beats', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 90 }, { beat: 8, bpm: 170 }, { beat: 40, bpm: 55 }], 120);
  let previous = -Infinity;
  for (let b = 0; b < 120; b += 0.25) {
    const s = beatsToSeconds(map, b);
    assert.ok(s > previous);
    previous = s;
  }
});

test('negative beats extrapolate backwards for pickup bars', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 120 }], 120);
  assert.equal(beatsToSeconds(map, -4), -2);
});

test('an out-of-range or duplicated tempo event does not corrupt the map', () => {
  const map = buildTempoMap(
    [{ beat: 0, bpm: 120 }, { beat: 0, bpm: 140 }, { beat: 8, bpm: 10_000 }],
    120,
  );
  assert.equal(map.segments.length, 1);
  assert.equal(map.segments[0].bpm, 140); // last write at a beat wins
});

test('bar grid follows the meter instead of assuming four', () => {
  const map = buildTempoMap([{ beat: 0, bpm: 120 }], 120);
  const four = buildBarGrid(map, [{ beat: 0, numerator: 4, denominator: 4 }], 8);
  assert.equal(four[1].beat, 4);
  const sixEight = buildBarGrid(map, [{ beat: 0, numerator: 6, denominator: 8 }], 8);
  assert.equal(sixEight[1].beat, 3); // 6 * (4/8)
});
