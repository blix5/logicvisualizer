# Logic Visualizer

A standalone macOS Electron app that reads Logic Pro X `.logicx` projects and
plays the arrangement back in its own view, with the playhead locked at
horizontal centre and the arrangement scrolling past it.

Logic exposes no transport or playhead API, so the app runs its own clock. You
import a bounced mixdown of the same project; the visual timeline is slaved to
that audio, so the two line up.

## Use

```bash
npm start
```

1. **Open project…** — pick a `.logicx` bundle.
2. **Import bounce…** — pick a bounced mixdown (wav/aif/mp3/m4a/caf/flac).
3. **offset** — bounce-local seconds at which project bar 1 occurs. Nudge it
   until a downbeat crosses the centre line on the transient.

| Input | Action |
|---|---|
| Space | play / pause |
| ⌘-scroll | zoom |
| scroll | move vertically |
| shift-scroll | scrub |
| Home | back to bar 1 |

**Arrange** is the Logic-like view; **Stylized** is the same data with glow and
note flashes at the playhead.

The transport readout shows the position and the tempo **at the playhead**,
which follows the project's tempo map. The status bar shows the project's base
tempo and how many tempo changes were decoded.

Audio regions draw their waveform. The project's audio files are read, decoded
and reduced to peaks in the background when a project opens, so regions fill in
over the first few seconds; the status bar shows the progress.

Project audio clips are drawn but never sounded — the bounce is the only sound
source, so what you hear always matches what Logic would play.

A region trimmed out of a longer file draws that file from its beginning, because
the region's start offset into its source file is not decoded yet (see
[`VENDORED.md`](src/main/logic/VENDORED.md)). Untrimmed regions are exact, and the
status bar says how many regions are affected.

## Development

```bash
npm start          # run the app
npm run typecheck  # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test           # unit tests + every .logicx in ~/Music/Logic
```

Dev CLIs, which need no UI and are how the parser is actually developed:

```bash
node scripts/probe.mjs "~/Music/Logic/solace.logicx"   # dump one parsed project
node scripts/probe.mjs "<path>" --json                 # the full model
node scripts/sweep.mjs                                 # parse every project, one line each
```

`LV_PROJECTS_DIR` overrides the project folder the real-project test suite uses.

## Layout

```
src/shared/      imported by both processes — no node:, no electron
src/main/logic/  the .logicx parser (see src/main/logic/VENDORED.md)
src/main/project/ parser output -> the renderer-facing ProjectModel
src/renderer/    React chrome + a canvas render loop that lives outside React
```

The parser's read path is vendored from Texture; the audio parser is new. The
binary-format notes, and an honest account of what is and is not yet decoded,
are in [`src/main/logic/VENDORED.md`](src/main/logic/VENDORED.md).
