# Vendored Logic parser

Source: `/Users/peter/texture-app/src/music_clipboard/electron_ui/app/src/logic/`

## Rules

1. **This directory is read-only with respect to Logic projects.** No file here may
   write a ProjectData buffer, shell out to `osascript`, or call `fs.writeFile*`.
   The one permitted subprocess is `plutil -convert json` in `logicPlist.ts`.
   Upstream fixes to Texture's *write* paths are irrelevant here; fixes to the
   *read* paths (note-block walking, LE/BE probing, track-name strategies) should
   be ported by hand. There is no automated sync.
2. Keep the binary-format comments. They record findings that cost real effort to
   recover and are not re-derivable from the code.

## Per-file provenance

| File | Origin |
|---|---|
| `ops/binary.ts` | copied verbatim |
| `ops/tempo.ts` | copied, write half removed (`setStartTempo`, `proveStartTempoEdit`) |
| `ops/timeSignature.ts` | copied, write half removed |
| `ops/markers.ts` | copied, write half + RTF authoring removed |
| `ops/regionCells.ts` | copied, region-creation half removed |
| `ops/trackObjects.ts` | copied, reduced to the closure reachable from `listLogicTracks` |
| `ops/types.ts` | rewritten — only `ByteRange` survives |
| `logicPlist.ts` | copied, read half only |
| `logicPaths.ts` | extracted from `logicProject.ts`; autosave `.songData` deliberately dropped |
| `logicImage.ts` | extracted from `logicProject.ts` (`readLogicImage`) |
| `trackNames.ts` | extracted from `logicProject.ts` (the three name strategies) |
| `midiRegions.ts` | rewritten — joins `scanRegionCells` (position/length) with a note-block walk |
| `logicAudio.ts` | **new.** Texture parses no audio at all |

## Audio format notes

Tags are byte-reversed 4CCs, as everywhere in ProjectData.

`AuFl`/`AUFL` (`lFuA`/`LFUA`) — audio file records. The filename sits immediately
*before* the `LFUA` tag, **UTF-16LE**, with a u16LE character count at
`nameStart - 2`. Grepping the buffer for ASCII `.wav` finds nothing, which is why
this was missed at first.

`AuRg` (`gRuA`) — audio region records, stride ~257-259:

| Offset | Meaning |
|---|---|
| `+10` u32LE | file oid == `4 * (AuFl record index)` |
| `+42` u32LE | length in samples |
| `+50` u32LE | position in samples, origin `sampleRate * 3600` (1-hour SMPTE start) |
| `+58` u32LE | start offset within the source file, in samples |
| `+110` u16LE | name length; ASCII name at `+112` |

`+42`/`+50`/`+58` are **not** 4-byte aligned relative to the tag, and audio is
addressed in **samples**, not ticks — unlike every MIDI structure in the file.
Both facts defeat the obvious scans.

### The arrangement — solved

An `AuRg` record says **what** a region is; **where** it sits lives in arrangement
units of 80 bytes.

| Offset | Meaning |
|---|---|
| `+0` u32 | `0x24` unit marker |
| `+4` u32 | position in **ticks**, origin **34560** = bar 1 (*not* MIDI's 38400) |
| `+13` u8 | selection state; ignore |
| `+16` u32 | track ref |
| `+20` u8 | 1-based track number |
| `+40` u32 | index of the unit within its track |
| `+44` u32 | **region ref** — matches an `AuRg`'s `+10` |
| `+52` i8 | **clip gain** in whole decibels, signed |

Plus, on the region definition: `+10` = its oid, `+42` = **trim-in** (where the
region starts inside its source file, in samples), `+58` = **length in samples**.

**Finding the units.** Do *not* frame them by the `qSvE` payload field. The
records are **not 4-byte aligned** — solace.logicx's first unit is at offset
889245 — so a scan stepping by 4 walks past every record in the file. And a real
arrangement chunk interleaves other record types, so the 80-byte grid is not
contiguous. Scan for the `0x24` marker at every byte offset and validate each
record independently on its position and track number.

### How it was established

Six controlled probes at 120 BPM / 4/4, diffed with `scripts/re/alignDiff.mjs`:

| Probe | Edit | Byte evidence |
|---|---|---|
| 1 | regions at bars 1/5/17, tracks 1/2/3, 4/8/2 bars | baseline |
| 2 | clip 2 moved one bar right | unit1 `+4`: 49920 → 53760 = **+3840 ticks, one bar** |
| 3 | clip 3 lengthened two bars | its `AuRg +58`: 176400 → 352800 = **2 → 4 bars** |
| 4 | clip 1 moved to track 3 | unit0 `+16`: 88 → 96, `+20`: 1 → 3 |
| 5 | **3 regions of different lengths on ONE track** | `+44`: 8/16/24 → lengths **4/8/6 bars** |
| 6 | 12 regions across 4 tracks | 13 units, all resolved, distinct refs |
| 7 | 1/2/3 bars cut off the FRONT of probe5's three regions | each moved later, shortened, and gained trim-in by the same amount: `AuRg +42` 0 → 88200/176400/264600 |
| 8 | tracks 2 and 3 muted | `OCuA +126` set on exactly those two channels |
| 9 | a volume ramp, 0 dB at bar 1 to -inf at bar 21 | a new 16-byte-record `qSvE` (see Automation) |
| 10 | region 1 at +5 dB, region 3 at -3 dB | unit `+52`: 0 → `0x05` and 0 → `0xfd` |
| 11 | pan added on track 2, volume kept | one chunk, 3116 records: 2925 volume + 191 pan, split by the `+12` parameter id |

**Probe 5 is the one that mattered.** In probes 1–4 every region sat on its own
track, which makes a per-track field and a per-region field indistinguishable —
and led to `+44` being wrongly dismissed as per-track. Probe 5 forces them apart.

Independent corroboration from real projects' `WindowImage.jpg`:
`solace.logicx` decodes to 190 regions, 0 unresolved, and its track names line up
exactly with the screenshot — "Steven Cymatics - Steam Drum Loop" on track 29,
the `summer_1` stems on tracks 30–36, vocal chops on 22–26, dense guitar chops on
28. `guitarheavystrumtjhing.logicx`'s single region decodes to bar 1, ~16.3 bars,
matching its screenshot.

### What was withdrawn along the way

An earlier reading of `AuRg +42`/`+50`/`+58` as length / position / file-offset
was fitted to `solace.logicx` and was wrong. Two results killed it before the
probes existed:

1. Across **324 consecutive save pairs** from 45 projects' own
   `Project File Backups`, the u32 at `+50` **never changed once**, while `+42`
   and `+58` changed 17 and 51 times. A field that survives hundreds of real
   editing sessions untouched is not a position.
2. `guitarheavystrumtjhing.logicx` has one audio region, and its
   `WindowImage.jpg` shows it spanning ~bar 1 to bar 17. Its `+42` reads 88,200
   samples — one bar.

Both results were correct and both pointed the right way: the position is not in
the region record. `+58` did turn out to be the length, which is consistent with
it being the second-most-changed field in the save histories.

### MIDI placement — solved

MIDI regions are placed by the SAME 80-byte record, with marker **`0x20`**
instead of `0x24`, and the region ref in a **different slot**: `+8` (mirrored at
`+32`) where audio uses `+44`. Position (`+4`, origin 34560), track ref (`+16`)
and track number (`+20`) are shared. The ref matches a region cell's `oid`, and
that cell supplies the name, the length and the offset of the note block.

**This fixed a real rendering bug.** MIDI regions used to take their position
and length from `scanRegionCells` directly, but that scan also returns pool and
take entries whose fields are not timeline values: `mega_test.logicx` yields
cells at tick 0 claiming to be 2000 bars long, named "Untitled", on track ref 0.
The visible symptom was regions starting at the wrong time and overlapping — its
track-1 regions came out every 2 bars with 4-bar lengths, a 50% overlap, where
the arrangement records give every 4 bars with 4-bar lengths, exactly
contiguous, matching its `WindowImage.jpg`. Across the whole library **MIDI
region overlap went from widespread to 0 of 1,762 same-lane pairs.**

Audio regions still overlap on ~21% of same-lane pairs, and that appears to be
genuine: every (track, position) pair is distinct, so these are layered or
comped takes rather than duplicate placements.

### Track mute — solved

`OCuA + 126` is 1 when a track is muted, 0 otherwise, matched to a track via the
strip UUID that `resolveTrackChannelsByRef` already uses. Established with
re_probe8, which mutes exactly tracks 2 and 3: the flag is set on those two and
on no channel of re_probe6 or re_probe7, which mute nothing. A rival candidate at
`+117` bit 3 was **rejected** — it fires on the unmuted probes too.

### Automation — solved

Automation lives in its own `qSvE` whose payload is a whole number of 16-byte
records:

| Offset | Meaning |
|---|---|
| `+0` u16 | `0x0050` record marker |
| `+4` u32 | position in **ticks**, origin **38400** (the MIDI origin, not the arrangement's 34560) |
| `+8` u32 | value in **8.24 fixed point**: `/ 2^24` gives raw parameter units |
| `+12` u32 | **parameter id** in the low byte (`0x07` volume, `0x0a` pan), `0x40000000` set on every point after the first |

Units depend on the parameter: volume has 90 = unity (0 dB) and 0 = -inf; pan is
0..127 with **64 = centre**, so Logic's -64..+63 display is `value - 64`.

**Parameters share one chunk, interleaved.** re_probe11 automates volume and pan
on one track and produces a single 3116-record list — 2925 volume points and 191
pan points. Splitting on the parameter id is essential; without it the pan points
read as out-of-range volume. re_probe11's pan decodes to centre at bar 1,
**+62.9 at bar 13.02** and **-64 at bar 17.00**, matching how it was drawn.

Logic writes automation **densely, not as control points**: re_probe9's single
straight ramp from 0 dB at bar 1 to -inf at bar 21 is stored as **2925 records**,
one roughly every 26 ticks. Decoded, they sit on a straight line from 90.000 to
0.000 fader units with a **maximum deviation of 0.0022 units** — which is what
confirmed the encoding.

**The value is not a float32.** Reading those bytes as a float produces a
smooth-looking decay from 9e15 to 1.9e-37, which passes a naive "is it in range"
check and fooled an earlier attempt. The tell is that the top byte falls
linearly: `0x5a, 0x53, 0x4d, 0x47, …`. Any similar hunt should require the values
to *vary sensibly*, not merely to be finite.

The fader-to-dB taper is only calibrated at two points (90 = 0 dB, 0 = -inf), so
`faderToDecibels()` is approximate in between.

### Remaining gaps

- **Region → source file.** No pointer field exists: a scan for an offset that is
  constant across takes of one file and distinct between files finds a candidate
  in solace only, and nothing in `dark`, `2soon` or probe6. Resolution is
  therefore by name, which reaches **99.6%** of 12,370 placed regions. The rest
  are regions the user renamed by hand ("vocal demo"), which no rule can recover.
  An earlier claim that `AuRg +10` is a file oid was wrong — it is the region's
  own oid.
- **Region fades** (in/out). Clip gain, trim-in, length, mute, volume and pan
  are all decoded; fades are not.
- **Which track an automation lane belongs to.** The parameter is known
  (`0x07` volume, `0x0a` pan) and lanes are separated, but nothing yet ties a
  lane to its track, so a project with automation on several tracks produces
  lanes that cannot be attributed. `arp swell beat.logicx` yields 8 lanes with
  no way to say whose they are.
- **Plugin-parameter automation.** Only ids `0x07` and `0x0a` have been seen; a
  probe automating a plugin parameter would show whether those ids extend.


### Tempo — solved

Tempo records use the **38400** origin (the song-start record confirms it) and
`findTempoLists` decodes them correctly. Two practical findings:

- Logic bakes **tempo curves into dense discrete events** — `arp swell beat` has
  130 events at 240-tick (1/16-note) spacing ramping 89 → 89.1 → 89.15 BPM. So
  treating each event as a step is accurate, not an approximation.
- The `0x60` status scan yields **false-positive lists** in 5 of 50 projects
  (`sixeight.logicx`: 5 lists, 11 events, 1 real; the fakes sit near tick 2^31 at
  ~1.6 BPM). `selectTempoEvents()` in `src/main/project/tempoSelect.ts` picks the
  list containing the song-start event and filters implausible records.
