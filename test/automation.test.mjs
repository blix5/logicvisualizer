import test from 'node:test';
import assert from 'node:assert/strict';
import {
  faderAt, faderToAmplitude, faderToLevel, volumeGain, volumeLevel, combineVolumeCurves, FADER_UNITY,
} from '../.test-build/automation.mjs';

const curve = (points) => ({
  seconds: new Float64Array(points.map((p) => p[0])),
  fader: new Float32Array(points.map((p) => p[1])),
});

test('the curve interpolates between points and holds past either end', () => {
  const ramp = curve([[2, 90], [4, 0]]);
  assert.equal(faderAt(ramp, 0), 90, 'before the first point');
  assert.equal(faderAt(ramp, 3), 45, 'halfway down the ramp');
  assert.equal(faderAt(ramp, 10), 0, 'after the last point');
});

test('fader units map to amplitude by the MIDI volume law', () => {
  assert.equal(faderToAmplitude(FADER_UNITY), 1);
  assert.equal(faderToAmplitude(0), 0);
  // 127 is the fader's +6 dB ceiling: 40·log10(127/90) = 5.98 dB, about 2x.
  assert.ok(Math.abs(20 * Math.log10(faderToAmplitude(127)) - 6) < 0.05);
  assert.equal(faderToAmplitude(45), 0.25, 'half the fader is -12 dB');
});

test('opacity level is linear in fader units and never exceeds unity', () => {
  assert.equal(faderToLevel(45), 0.5);
  assert.equal(faderToLevel(127), 1);
  assert.equal(faderToLevel(0), 0);
});

test('a track without automation is left untouched', () => {
  assert.equal(volumeGain(null, 5), 1);
  assert.equal(volumeLevel(null, 5), 1);
});

test('faders in series multiply their gains', () => {
  // A member at -12 dB (45) inside a stack whose fader ramps unity -> -inf:
  // heard at 45 * (stack / 90).
  const member = curve([[0, 45]]);
  const stack = curve([[10, 90], [20, 0]]);
  const heard = combineVolumeCurves([member, stack]);
  assert.deepEqual([...heard.seconds], [0, 10, 20]);
  assert.equal(faderAt(heard, 5), 45);
  assert.equal(faderAt(heard, 15), 22.5);
  assert.equal(faderAt(heard, 25), 0);
  assert.ok(Math.abs(volumeGain(heard, 15) - volumeGain(member, 15) * volumeGain(stack, 15)) < 1e-12, 'amplitudes multiply');
  assert.equal(combineVolumeCurves([member]), member, 'one curve is returned as is');
  assert.equal(combineVolumeCurves([]), null);
});
