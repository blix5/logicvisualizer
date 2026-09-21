import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The vendored parser is read-only with respect to Logic projects. This guard
// stops a write path creeping back in during a future copy-paste from Texture.
const ROOT = new URL('../src/main/logic/', import.meta.url).pathname;
const FORBIDDEN = [/writeFileSync/, /writeFile\(/, /osascript/, /createWriteStream/];
const ALLOWED_EXEC = new Set(['logicPlist.ts']); // plutil -convert json

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('no write paths in the vendored parser', () => {
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(source), `${path.basename(file)} matches ${pattern}`);
    }
    if (!ALLOWED_EXEC.has(path.basename(file))) {
      assert.ok(!/execFileSync|execSync|spawnSync/.test(source), `${path.basename(file)} shells out`);
    }
  }
});
