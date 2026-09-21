import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPeakPyramid, levelForPixelsPerSecond, peakCount,
  PEAK_BASE_RATE, PEAK_LEVEL_STEP,
} from '../.test-build/peaks.mjs';

// Channel data is synthesized here rather than read from a committed .wav, so
// the reduction is exercised on signals whose expected envelope is known exactly.

function channel(frames, fill) {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) data[i] = typeof fill === 'function' ? fill(i) : fill;
  return data;
}

function bucket(pyramid, level, index) {
  const data = pyramid.levels[level];
  return { min: data[index * 2], max: data[index * 2 + 1] };
}

test('a full-scale square wave reaches the rails at every level', () => {
  const pyramid = buildPeakPyramid([channel(4000, (i) => (i % 2 === 0 ? 1 : -1))], 4000);
  for (let level = 0; level < pyramid.levels.length; level += 1) {
    for (let index = 0; index < peakCount(pyramid, level); index += 1) {
      assert.deepEqual(bucket(pyramid, level, index), { min: -127, max: 127 },
        `level ${level} bucket ${index} is not full scale`);
    }
  }
});

test('silence reduces to a flat zero envelope', () => {
  const pyramid = buildPeakPyramid([channel(4000, 0)], 4000);
  for (let level = 0; level < pyramid.levels.length; level += 1) {
    for (let index = 0; index < peakCount(pyramid, level); index += 1) {
      assert.deepEqual(bucket(pyramid, level, index), { min: 0, max: 0 });
    }
  }
});

test('samples beyond full scale clamp instead of wrapping the Int8', () => {
  // Without the clamp, round(2 * 127) = 254 stored into an Int8Array is -2.
  const pyramid = buildPeakPyramid([channel(1000, (i) => (i % 2 === 0 ? 2 : -2))], 1000);
  assert.deepEqual(bucket(pyramid, 0, 0), { min: -127, max: 127 });
});

test('every channel contributes to the combined envelope', () => {
  const pyramid = buildPeakPyramid([channel(1000, 1), channel(1000, -1)], 1000);
  assert.deepEqual(bucket(pyramid, 0, 0), { min: -127, max: 127 },
    'the second channel was not folded in');
});

test('level 0 holds ceil(duration * base rate) buckets for a fractional duration', () => {
  const pyramid = buildPeakPyramid([channel(1500, 0)], 1000);
  assert.equal(pyramid.durationSeconds, 1.5);
  assert.equal(peakCount(pyramid, 0), Math.ceil(1.5 * PEAK_BASE_RATE));
});

test('a coarse bucket is the min and max of the finer buckets it covers', () => {
  const frames = 4000;
  const pyramid = buildPeakPyramid([channel(frames, (i) => (i / frames) * 2 - 1)], 4000);
  const fineCount = peakCount(pyramid, 0);
  for (let index = 0; index < peakCount(pyramid, 1); index += 1) {
    let min = 127;
    let max = -127;
    const start = index * PEAK_LEVEL_STEP;
    for (let i = start; i < Math.min(fineCount, start + PEAK_LEVEL_STEP); i += 1) {
      const fine = bucket(pyramid, 0, i);
      if (fine.min < min) min = fine.min;
      if (fine.max > max) max = fine.max;
    }
    assert.deepEqual(bucket(pyramid, 1, index), { min, max }, `level 1 bucket ${index} drifted`);
  }
});

test('rates describe the buckets each level actually holds', () => {
  const pyramid = buildPeakPyramid([channel(16000, 0)], 4000);
  for (let level = 0; level < pyramid.levels.length; level += 1) {
    assert.equal(pyramid.rates[level], peakCount(pyramid, level) / pyramid.durationSeconds,
      `level ${level} rate does not match its bucket count`);
  }
});

test('level selection stays at 0 when no level can match the pixel rate', () => {
  const pyramid = buildPeakPyramid([channel(16000, 0)], 4000);
  assert.equal(levelForPixelsPerSecond(pyramid, PEAK_BASE_RATE * 2), 0);
});

test('level selection coarsens as pixels per second drops', () => {
  const pyramid = buildPeakPyramid([channel(16000, 0)], 4000);
  const zoomedIn = levelForPixelsPerSecond(pyramid, 400);
  const middle = levelForPixelsPerSecond(pyramid, 90);
  const zoomedOut = levelForPixelsPerSecond(pyramid, 8);
  assert.ok(zoomedIn < middle, 'no coarsening between 400 and 90 px/s');
  assert.ok(middle < zoomedOut, 'no coarsening between 90 and 8 px/s');
  // The chosen level must still carry at least one bucket per pixel.
  assert.ok(pyramid.rates[zoomedOut] >= 8, 'the zoomed-out level is under-resolved');
});

test('audio with no frames is rejected rather than reduced to an empty pyramid', () => {
  assert.throws(() => buildPeakPyramid([], 44100), /no audio frames/);
  assert.throws(() => buildPeakPyramid([new Float32Array(0)], 44100), /no audio frames/);
});

test('an implausible sample rate is rejected', () => {
  assert.throws(() => buildPeakPyramid([channel(100, 0)], 0), /sample rate/);
});
