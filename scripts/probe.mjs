// Dump one project's parsed model:  node scripts/probe.mjs <path.logicx> [--json]
import { runTs } from './run-ts.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/probe.mjs <path.logicx> [--json]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');

await runTs('src/main/project/buildProject.ts', ({ buildProjectModel }) => {
  const model = buildProjectModel(target);
  if (asJson) {
    console.log(JSON.stringify(model, (_k, v) => (ArrayBuffer.isView(v) ? `<${v.length} ints>` : v), 2));
    return;
  }
  const midi = model.regions.filter((r) => r.kind === 'midi');
  const audio = model.regions.filter((r) => r.kind === 'audio');
  const notes = midi.reduce((n, r) => n + r.noteCount, 0);
  console.log(`${model.projectName}  [${model.alternativeId}]`);
  console.log(`  ${model.baseBpm} BPM · ${model.sampleRate} Hz · key ${model.songKey ?? '?'} · ends ${model.endSeconds.toFixed(1)}s`);
  console.log(`  tracks ${model.tracks.length} · midi regions ${midi.length} (${notes} notes) · audio regions ${audio.length}`);
  console.log(`  tempo events ${model.tempoEvents.length} · signatures ${model.timeSignatures.length} · markers ${model.markers.length}`);
  console.log(`  audio files ${model.audioFiles.length} (${model.audioFiles.filter((f) => f.exists).length} present on disk)`);
  console.log(`  capabilities: ${Object.entries(model.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  for (const w of model.warnings) console.log(`  ! ${w}`);
  console.log('\n  first 8 regions:');
  for (const r of model.regions.slice(0, 8)) {
    const track = model.tracks.find((t) => t.id === r.trackId);
    const detail = r.kind === 'midi' ? `${r.noteCount} notes` : `file ${r.audioFileId ?? '?'}`;
    console.log(`    ${r.startSeconds.toFixed(2).padStart(8)}s  ${(r.endSeconds - r.startSeconds).toFixed(2).padStart(6)}s  ${r.kind.padEnd(5)} ${(track?.name ?? '?').slice(0, 22).padEnd(22)} ${r.name.slice(0, 26).padEnd(26)} ${detail}`);
  }
});
