import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTempo, flexedBeats } from '../.test-build/fileTempo.mjs';

/** A minimal RIFF WAVE with an optional LIST/adtl tempo label. */
function wav({ tempoLabel, dataBytes = 64 } = {}) {
  const parts = [];
  const fmt = Buffer.alloc(8 + 16);
  fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(44100, 12);
  parts.push(fmt);
  const data = Buffer.alloc(8 + dataBytes);
  data.write('data', 0, 'latin1'); data.writeUInt32LE(dataBytes, 4);
  parts.push(data);
  if (tempoLabel) {
    const text = Buffer.concat([
      Buffer.from('adtllabl', 'latin1'), Buffer.alloc(4), Buffer.from(tempoLabel, 'latin1'), Buffer.alloc(1),
    ]);
    const list = Buffer.alloc(8 + text.length + (text.length & 1));
    list.write('LIST', 0, 'latin1'); list.writeUInt32LE(text.length, 4); text.copy(list, 8);
    parts.push(list);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function tmpFile(bytes) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvtempo-')), 'a.wav');
  fs.writeFileSync(file, bytes);
  return file;
}

test('reads the "Tempo: N" label from a WAV, skipping the sample data', () => {
  assert.equal(readFileTempo(tmpFile(wav({ tempoLabel: 'Tempo: 110.0', dataBytes: 100_000 }))), 110);
});

test('a WAV with no tempo returns null', () => {
  assert.equal(readFileTempo(tmpFile(wav())), null);
});

test('a non-WAV file returns null rather than throwing', () => {
  assert.equal(readFileTempo(tmpFile(Buffer.from('not audio at all'))), null);
});

test('flexed length rounds to the whole number of beats the loop holds', () => {
  // key3.wav in djpubichair: 4.3297 s labelled 110 BPM is 7.94 beats -- an
  // 8-beat loop, exactly 2 bars at project tempo. The label is rounded (the
  // length implies 110.86), so rounding is what recovers the exact count.
  assert.equal(flexedBeats(190_941 / 44_100, 110), 8);
});

test('audio that is not near a whole number of beats is left unstretched', () => {
  assert.equal(flexedBeats(1.0, 90), null); // 1.5 beats
});
