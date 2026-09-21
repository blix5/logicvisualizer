import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAutomationLanes, faderToDecibels, panToDisplay,
  FADER_UNITY, PAN_CENTRE, AUTOMATION_PARAM_VOLUME, AUTOMATION_PARAM_PAN,
} from '../.test-build/logicAutomation.mjs';

const TICK_ORIGIN = 38400;
const BAR = 3840;

/** A qSvE holding 16-byte automation records. */
function automationChunk(points) {
  const payload = points.length * 16;
  const chunk = Buffer.alloc(36 + payload + 8);
  chunk.write('qSvE', 0, 'ascii');
  chunk.writeUInt32LE(payload + 16, 28);
  points.forEach((p, i) => {
    const at = 36 + i * 16;
    chunk.writeUInt16LE(p.marker ?? 0x0050, at);
    chunk.writeUInt32LE(TICK_ORIGIN + p.bar * BAR, at + 4);
    chunk.writeUInt32LE(Math.round(p.fader * (1 << 24)), at + 8);
    chunk.writeUInt32LE(0x40000000 | (p.param ?? AUTOMATION_PARAM_VOLUME), at + 12);
  });
  return chunk;
}

test('automation records decode position and 8.24 fixed-point fader', () => {
  const buffer = automationChunk([
    { bar: 0, fader: 90 }, { bar: 4, fader: 60 }, { bar: 8, fader: 30 }, { bar: 12, fader: 0 },
  ]);
  const [lane] = parseAutomationLanes(buffer);
  assert.equal(lane.points.length, 4);
  assert.deepEqual(lane.points.map((p) => p.positionTicks), [0, 4 * BAR, 8 * BAR, 12 * BAR]);
  assert.deepEqual(lane.points.map((p) => p.value), [90, 60, 30, 0]);
  assert.equal(lane.parameterId, AUTOMATION_PARAM_VOLUME);
});

test('the value is fixed point, not float32', () => {
  // Reading these bytes as a float32 yields ~9e15 and passes a naive range
  // check on a decaying curve. The fixed-point read gives unity.
  const buffer = automationChunk([{ bar: 0, fader: FADER_UNITY }]);
  assert.equal(buffer.readFloatLE(36 + 8) > 1e15, true, 'float misreading is plausible-looking');
  const parsed = parseAutomationLanes(automationChunk(
    Array.from({ length: 8 }, (_, i) => ({ bar: i, fader: FADER_UNITY })),
  ));
  assert.equal(parsed[0].points[0].value, FADER_UNITY);
});

test('a list that is not time-ordered is rejected', () => {
  const buffer = automationChunk([
    { bar: 0, fader: 90 }, { bar: 8, fader: 60 }, { bar: 4, fader: 30 }, { bar: 12, fader: 0 },
  ]);
  assert.deepEqual(parseAutomationLanes(buffer), []);
});

test('a list with a wrong record marker is rejected', () => {
  const buffer = automationChunk([
    { bar: 0, fader: 90 }, { bar: 4, fader: 60 }, { bar: 8, fader: 30, marker: 0x24 }, { bar: 12, fader: 0 },
  ]);
  assert.deepEqual(parseAutomationLanes(buffer), []);
});

test('parameters sharing one chunk are split into separate lanes', () => {
  // Logic interleaves every automated parameter into the same record list;
  // without splitting on the parameter id, pan looks like out-of-range volume.
  const points = [];
  for (let i = 0; i < 8; i += 1) {
    points.push({ bar: i, fader: 90 - i, param: AUTOMATION_PARAM_VOLUME });
    points.push({ bar: i, fader: PAN_CENTRE + i, param: AUTOMATION_PARAM_PAN });
  }
  const lanes = parseAutomationLanes(automationChunk(points));
  assert.equal(lanes.length, 2);
  const volume = lanes.find((l) => l.parameterId === AUTOMATION_PARAM_VOLUME);
  const pan = lanes.find((l) => l.parameterId === AUTOMATION_PARAM_PAN);
  assert.equal(volume.points.length, 8);
  assert.equal(pan.points.length, 8);
  assert.equal(pan.points[0].value, PAN_CENTRE);
});

test('pan units map to Logic\'s -64..+63 display scale', () => {
  assert.equal(panToDisplay(PAN_CENTRE), 0);
  assert.equal(panToDisplay(0), -64);
  assert.equal(panToDisplay(127), 63);
});

test('fader units convert to decibels with unity at 90', () => {
  assert.equal(faderToDecibels(FADER_UNITY), 0);
  assert.equal(faderToDecibels(0), -Infinity);
  assert.ok(faderToDecibels(45) < 0);
});

test('probe9 decodes as one straight ramp from unity to -inf', { skip: (() => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(root, 're_probe9.logicx')) && 're_probe9.logicx not found';
})() }, () => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  const buffer = fs.readFileSync(path.join(root, 're_probe9.logicx', 'Alternatives/000/ProjectData'));
  const lanes = parseAutomationLanes(buffer);
  assert.equal(lanes.length, 1, 'exactly one automated lane');
  assert.equal(lanes[0].parameterId, AUTOMATION_PARAM_VOLUME);
  const points = lanes[0].points;
  assert.ok(points.length > 2000, 'Logic writes automation densely, not as control points');

  const first = points[0];
  const last = points[points.length - 1];
  assert.equal(first.positionTicks, 0, 'ramp starts at bar 1');
  assert.equal(first.value, FADER_UNITY, 'starts at 0 dB');
  assert.equal(last.value, 0, 'ends at -inf');
  const endBar = last.positionTicks / BAR + 1;
  assert.ok(endBar > 20.9 && endBar < 21.1, `ends near bar 21 (got ${endBar.toFixed(3)})`);

  // Every point lies on the straight line between the endpoints.
  const span = last.positionTicks - first.positionTicks;
  let worst = 0;
  for (const p of points) {
    const expected = FADER_UNITY * (1 - (p.positionTicks - first.positionTicks) / span);
    worst = Math.max(worst, Math.abs(p.value - expected));
  }
  assert.ok(worst < 0.01, `ramp is linear within 0.01 fader units (worst ${worst.toFixed(4)})`);
});

test('probe11 separates a volume ramp from a pan curve on one track', { skip: (() => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(root, 're_probe11.logicx')) && 're_probe11.logicx not found';
})() }, () => {
  const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  const buffer = fs.readFileSync(path.join(root, 're_probe11.logicx', 'Alternatives/000/ProjectData'));
  const lanes = parseAutomationLanes(buffer);
  assert.equal(lanes.length, 2, 'volume and pan come out as two lanes');

  const volume = lanes.find((l) => l.parameterId === AUTOMATION_PARAM_VOLUME);
  const pan = lanes.find((l) => l.parameterId === AUTOMATION_PARAM_PAN);
  assert.ok(volume && pan);

  // The volume ramp from probe9 is untouched.
  assert.equal(volume.points[0].value, FADER_UNITY);
  assert.equal(volume.points[volume.points.length - 1].value, 0);

  // Pan was drawn as 0 at bar 1, +62 at bar 13, -64 at bar 17.
  const bar = (p) => p.positionTicks / BAR + 1;
  assert.equal(panToDisplay(pan.points[0].value), 0, 'starts centred');
  const peak = pan.points.reduce((a, b) => (b.value > a.value ? b : a));
  assert.ok(Math.abs(panToDisplay(peak.value) - 62) < 1.5, `peaks near +62 (got ${panToDisplay(peak.value).toFixed(2)})`);
  assert.ok(Math.abs(bar(peak) - 13) < 0.2, `peak near bar 13 (got ${bar(peak).toFixed(2)})`);
  const trough = pan.points.reduce((a, b) => (b.value < a.value ? b : a));
  assert.equal(panToDisplay(trough.value), -64, 'reaches hard left');
  assert.ok(Math.abs(bar(trough) - 17) < 0.2, `hard left near bar 17 (got ${bar(trough).toFixed(2)})`);
});
