// Dump one project's parsed model:  node scripts/probe.mjs <path.logicx> [--json | --tracks]
import { runTs } from './run-ts.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/probe.mjs <path.logicx> [--json | --tracks]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');
const asTracks = process.argv.includes('--tracks');

await runTs('src/main/project/buildProject.ts', ({ buildProjectModel }) => {
  const model = buildProjectModel(target);
  if (asJson) {
    console.log(JSON.stringify(model, (_k, v) => (ArrayBuffer.isView(v) ? `<${v.length} ints>` : v), 2));
    return;
  }
  if (asTracks) {
    // The track list as Logic's track headers show it, stacks indented.
    const counts = new Map();
    for (const r of model.regions) counts.set(r.trackId, (counts.get(r.trackId) ?? 0) + 1);
    const bus = (n) => (n === null ? 'Stereo Out' : `Bus ${n}`);
    for (const t of model.tracks) {
      const head = t.stack ? `[${t.stack.summing ? 'sum' : 'stack'}${t.stack.expanded ? '' : ', closed'}] ` : '';
      const ch = t.channel
        ? `${t.channel.name}${t.channel.inputBus !== null ? ` <- ${bus(t.channel.inputBus)}` : ''} -> ${bus(t.channel.outputBus)}`
        : 'no channel';
      const label = `${String(t.number ?? '?').padStart(3)} ${'   '.repeat(t.depth)}${head}${t.name}`;
      const by = model.tracks.find((x) => x.id === t.mutedBy);
      const mute = !t.muted ? '' : by && by.id !== t.id ? `, muted by ${by.number ?? '?'} ${by.name}` : ', muted';
      const vol = t.volume ? (t.ownVolume === t.volume ? ', volume' : t.ownVolume ? ', volume + inherited' : ', inherited volume') : '';
      console.log(`${label.padEnd(56)} ${ch.padEnd(28)} ${counts.get(t.id) ?? 0} regions${mute}${vol}`);
    }
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
