import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeAppleScriptString,
  formatAppleScriptErrorForUser,
  findRunningLogicVariant,
  openLogicProject,
  LOGIC_PRO_VARIANTS,
} from '../.test-build/logicControl.mjs';

test('escapeAppleScriptString escapes backslashes and quotes', () => {
  assert.equal(escapeAppleScriptString('a"b'), 'a\\"b');
  assert.equal(escapeAppleScriptString('a\\b'), 'a\\\\b');
  assert.equal(escapeAppleScriptString('/Users/x/My Song.logicx'), '/Users/x/My Song.logicx');
});

test('formatAppleScriptErrorForUser maps the Accessibility error', () => {
  const msg = formatAppleScriptErrorForUser(new Error('osascript: -1719 not allowed assistive access'));
  assert.match(msg, /Accessibility permission/);
});

test('formatAppleScriptErrorForUser maps the Automation error', () => {
  const msg = formatAppleScriptErrorForUser({ stderr: 'Not authorized to send Apple events' });
  assert.match(msg, /Automation permission/);
});

test('formatAppleScriptErrorForUser surfaces the concise stderr line otherwise', () => {
  const msg = formatAppleScriptErrorForUser({ stderr: 'Command failed: osascript\nsomething broke' });
  assert.equal(msg, 'Logic automation failed: something broke');
});

test('findRunningLogicVariant returns the first running variant', () => {
  const running = new Set(['Logic Pro']);
  const variant = findRunningLogicVariant((name) => running.has(name));
  assert.equal(variant?.processName, 'Logic Pro');
});

test('findRunningLogicVariant returns null when none run', () => {
  assert.equal(findRunningLogicVariant(() => false), null);
});

test('openLogicProject opens with the first variant whose app name works', () => {
  const calls = [];
  const variant = openLogicProject('/tmp/x.logicx', {
    exists: () => true,
    exec: (file, args) => {
      calls.push(args[1]); // the app name after -a
      if (args[1] !== 'Logic Pro') throw new Error('not installed');
    },
  });
  // First variant ("Logic Pro Creator Studio") throws, second succeeds.
  assert.equal(variant?.appName, 'Logic Pro');
  assert.deepEqual(calls, ['Logic Pro Creator Studio', 'Logic Pro']);
});

test('openLogicProject returns null when the path is missing', () => {
  assert.equal(openLogicProject('/nope.logicx', { exists: () => false, exec: () => {} }), null);
});

test('LOGIC_PRO_VARIANTS lists the known apps', () => {
  assert.ok(LOGIC_PRO_VARIANTS.some((v) => v.appName === 'Logic Pro'));
  assert.ok(LOGIC_PRO_VARIANTS.some((v) => v.appName === 'Logic Pro X'));
});
