import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProjectModel } from '../.test-build/buildProject.mjs';

// Gated on an env var with a sensible default rather than a hardcoded absolute
// path, so this suite actually runs on a machine that has projects.
const root = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
const projects = fs.existsSync(root)
  ? fs.readdirSync(root).filter((n) => n.endsWith('.logicx')).sort()
  : [];

test('real projects parse and satisfy the model invariants', { skip: projects.length === 0 && 'no .logicx projects found' }, async (t) => {
  for (const name of projects) {
    await t.test(name, () => {
      const started = Date.now();
      const model = buildProjectModel(path.join(root, name));
      assert.ok(Date.now() - started < 8000, 'parse finished in reasonable time');
      assert.equal(model.schemaVersion, 1);
      assert.ok(model.baseBpm >= 20 && model.baseBpm <= 400, `tempo ${model.baseBpm} in range`);
      assert.ok(model.sampleRate > 0);

      for (const event of model.tempoEvents) {
        assert.ok(Number.isFinite(event.beat) && event.bpm >= 1 && event.bpm <= 999);
      }

      let previous = -Infinity;
      for (const region of model.regions) {
        assert.ok(Number.isFinite(region.startSeconds), `${region.name} has finite start`);
        assert.ok(region.endSeconds >= region.startSeconds, `${region.name} does not end before it starts`);
        assert.ok(region.startSeconds >= previous, 'regions are sorted by start time');
        previous = region.startSeconds;
        assert.ok(model.tracks.some((t2) => t2.id === region.trackId), `${region.name} lands on a real track`);
      }

      for (const file of model.audioFiles) {
        if (file.absolutePath) assert.equal(typeof file.exists, 'boolean');
      }
    });
  }
});
