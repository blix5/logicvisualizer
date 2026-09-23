// Bundles the modules under test to .test-build/ so plain node --test files can
// import them without a TypeScript loader.
import { build } from 'esbuild';

await build({
  entryPoints: {
    timebase: 'src/shared/timebase.ts',
    model: 'src/shared/model.ts',
    automation: 'src/shared/automation.ts',
    logicAudio: 'src/main/logic/logicAudio.ts',
    logicAutomation: 'src/main/logic/logicAutomation.ts',
    midiRegions: 'src/main/logic/midiRegions.ts',
    trackTree: 'src/main/logic/trackTree.ts',
    fileTempo: 'src/main/audio/fileTempo.ts',
    buildProject: 'src/main/project/buildProject.ts',
    peaks: 'src/renderer/render/peaks.ts',
    rollScene: 'src/renderer/render/rollScene.ts',
    transcribe: 'src/renderer/audio/transcribe.ts',
    logicControl: 'src/main/bounce/logicControl.ts',
    autoBounce: 'src/main/bounce/autoBounce.ts',
    color: 'src/renderer/theme/color.ts',
    themes: 'src/renderer/theme/themes.ts',
    palettes: 'src/renderer/theme/palettes.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: '.test-build',
  outExtension: { '.js': '.mjs' },
  external: ['electron'],
  logLevel: 'error',
});
