import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoBounceProject,
  buildBounceScript,
  buildDocumentOpenScript,
  isBounceAudioFile,
  newestBounceFile,
} from '../.test-build/autoBounce.mjs';

const VARIANT = { appName: 'Logic Pro', processName: 'Logic Pro' };

test('buildDocumentOpenScript targets the bundle path', () => {
  const script = buildDocumentOpenScript(VARIANT, '/Users/x/Song.logicx');
  assert.match(script, /tell application "Logic Pro"/);
  assert.match(script, /if dp is "\/Users\/x\/Song\.logicx"/);
});

test('buildBounceScript drives Cmd+B, confirms settings with OK, then the save panel', () => {
  const script = buildBounceScript(VARIANT, '/tmp/lv-bounce/abc');
  assert.match(script, /keystroke "b" using \{command down\}/);
  // Settings dialog is confirmed with OK (fallback Bounce), save panel with Bounce (fallback Save).
  assert.match(script, /waitForButton\("Logic Pro", \{"OK", "Bounce"\}\)/);
  assert.match(script, /waitForButton\("Logic Pro", \{"Bounce", "Save"\}\)/);
  assert.match(script, /keystroke "g" using \{command down, shift down\}/);
  assert.match(script, /keystroke "\/tmp\/lv-bounce\/abc"/);
  // Go-to-folder is confirmed with the physical Return key, and the save panel's
  // Bounce button is found by descending into the window's splitter groups.
  assert.match(script, /key code 36/);
  assert.match(script, /splitter groups of w/);
  assert.match(script, /Bounce dialog did not appear/);
  assert.match(script, /Save dialog did not appear/);
});

test('isBounceAudioFile accepts audio extensions, rejects others', () => {
  assert.ok(isBounceAudioFile('Song.wav'));
  assert.ok(isBounceAudioFile('Song.AIF'));
  assert.ok(isBounceAudioFile('mix.m4a'));
  assert.ok(!isBounceAudioFile('Song.logicx'));
  assert.ok(!isBounceAudioFile('notes.txt'));
});

test('newestBounceFile picks the newest audio file and ignores non-audio', () => {
  const chosen = newestBounceFile([
    { name: 'a.wav', size: 10, mtimeMs: 100 },
    { name: 'b.wav', size: 20, mtimeMs: 300 },
    { name: 'readme.txt', size: 99, mtimeMs: 999 },
  ]);
  assert.equal(chosen?.name, 'b.wav');
});

test('newestBounceFile returns null when there is no audio', () => {
  assert.equal(newestBounceFile([{ name: 'x.txt', size: 1, mtimeMs: 1 }]), null);
});

test('autoBounceProject wires the steps together and returns the output path', async () => {
  const seen = {};
  const outcome = await autoBounceProject('/Users/x/Song.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => { seen.resolved = p; return '/Users/x/Song.logicx'; },
    makeOutDir: (bundle) => { seen.outDirFor = bundle; return '/tmp/out'; },
    openProject: (bundle) => { seen.opened = bundle; return VARIANT; },
    waitForDocument: () => ({ ok: true }),
    getVariant: () => VARIANT,
    runBounce: (variant, outDir) => { seen.bounced = outDir; return { ok: true }; },
    waitForOutput: (outDir) => `${outDir}/mix.wav`,
  });
  assert.deepEqual(outcome, { ok: true, path: '/tmp/out/mix.wav' });
  assert.equal(seen.opened, '/Users/x/Song.logicx');
  assert.equal(seen.bounced, '/tmp/out');
});

test('autoBounceProject fails fast off macOS', async () => {
  const outcome = await autoBounceProject('/x.logicx', { platform: 'win32' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /only available on macOS/);
});

test('autoBounceProject reports an unresolvable bundle', async () => {
  const outcome = await autoBounceProject('/x', { platform: 'darwin', resolveBundle: () => null });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /not a readable \.logicx/);
});

test('autoBounceProject reports when Logic cannot open the project', async () => {
  const outcome = await autoBounceProject('/x.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => p,
    makeOutDir: () => '/tmp/out',
    openProject: () => null,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Is Logic Pro installed/);
});

test('autoBounceProject surfaces a bounce script failure', async () => {
  const outcome = await autoBounceProject('/x.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => p,
    makeOutDir: () => '/tmp/out',
    openProject: () => VARIANT,
    waitForDocument: () => ({ ok: true }),
    getVariant: () => VARIANT,
    runBounce: () => ({ ok: false, error: 'Accessibility permission is required.' }),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Accessibility permission/);
});

test('autoBounceProject emits a status message at each phase', async () => {
  const statuses = [];
  await autoBounceProject('/x.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => p,
    makeOutDir: () => '/tmp/out',
    openProject: () => VARIANT,
    waitForDocument: () => ({ ok: true }),
    getVariant: () => VARIANT,
    runBounce: () => ({ ok: true }),
    waitForOutput: () => '/tmp/out/mix.wav',
    onStatus: (m) => statuses.push(m),
  });
  assert.ok(statuses.some((s) => /Opening the project/i.test(s)));
  assert.ok(statuses.some((s) => /rendering/i.test(s)));
});

test('autoBounceProject stops when the cancel token is set before the bounce', async () => {
  const token = { cancelled: false };
  let bounced = false;
  const outcome = await autoBounceProject('/x.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => p,
    makeOutDir: () => '/tmp/out',
    openProject: () => VARIANT,
    // Cancel during the document wait, before the bounce is driven.
    waitForDocument: () => { token.cancelled = true; return { ok: true }; },
    getVariant: () => VARIANT,
    runBounce: () => { bounced = true; return { ok: true }; },
    waitForOutput: () => '/tmp/out/mix.wav',
    cancelToken: token,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, true);
  assert.equal(bounced, false, 'bounce must not run once cancelled');
});

test('autoBounceProject reports a missing output file', async () => {
  const outcome = await autoBounceProject('/x.logicx', {
    platform: 'darwin',
    resolveBundle: (p) => p,
    makeOutDir: () => '/tmp/out',
    openProject: () => VARIANT,
    waitForDocument: () => ({ ok: true }),
    getVariant: () => VARIANT,
    runBounce: () => ({ ok: true }),
    waitForOutput: () => null,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /did not produce an audio file/);
});
