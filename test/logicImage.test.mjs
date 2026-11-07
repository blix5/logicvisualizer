import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUndoHistory } from '../.test-build/logicImage.mjs';

// The chunk header that follows every 4cc tag in ProjectData: 0x0002, then 0xff.
const header = (tag) => Buffer.concat([Buffer.from(tag, 'ascii'), Buffer.from([0x02, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01])]);

test('the live song is kept and the undo history after it is cut off', () => {
  const song = Buffer.concat([header('gnoS'), Buffer.from('qSvE live arrangement', 'ascii')]);
  const undo = Buffer.concat([header('ktSU'), header('gnoS'), Buffer.from('qSvE snapshot', 'ascii')]);
  const image = Buffer.concat([song, undo, undo]);
  assert.deepEqual(stripUndoHistory(image), song);
});

test('an image without undo history is returned whole', () => {
  const image = Buffer.concat([header('gnoS'), Buffer.from('qSvE only the song', 'ascii')]);
  assert.equal(stripUndoHistory(image), image);
});

test('the tag inside a name, without a chunk header, does not cut', () => {
  const song = Buffer.concat([header('gnoS'), Buffer.from('region named ktSU loop', 'ascii')]);
  const undo = Buffer.concat([header('ktSU'), Buffer.from('snapshot', 'ascii')]);
  assert.deepEqual(stripUndoHistory(Buffer.concat([song, undo])), song);
});
