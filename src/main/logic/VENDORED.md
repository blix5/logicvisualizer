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
| `+0` u16 | `0x24` unit marker |
| `+2` u16 | **sub-tick fraction** of the position (`/ 65536`); non-zero only off-grid |
| `+4` u32 | position in **ticks**, origin **34560** = bar 1 (*not* MIDI's 38400) |
| `+13` u8 | selection state; ignore |
| `+16` u32 | track ref |
| `+20` u8 | 1-based track number |
| `+40` u32 | index of the unit within its track |
| `+40` u32 | **ordinal**, selecting among the `AuRg` records that share the ref |
| `+48` u8 | flags; **bit 7 = Flex on** |
| `+44` u32 | **region ref** — matches an `AuRg`'s `+10` |
| `+52` i8 | **clip gain** in whole decibels, signed |

On the region definition: `+10` = its **source file's oid**, `+14` = its
**ordinal** among the regions cut from that file, `+42` = **trim-in** (where the
region starts inside its source file, in samples), `+58` = **length in samples**.

**`+10` is a direct file pointer: 4 × the file's `AuFl` index.** Every region cut
from one file shares it, which is why it is not a unique region key — the
placement's `+40` ordinal picks the region. In `djpubichair.logicx` all 129 file
groups check out: every region fits inside the audio of `AuFl[oid]`, 96 of them
spanning it exactly.

This corrects an earlier retraction. The pointer was the first reading, then
withdrawn when placements turned out to reference `+10` (it looked like a region
id). It is the file; the placement simply points at a file and an ordinal within
it. Resolving files by NAME instead picked the wrong one for **102 regions** in
the corpus, where a take suffix like `X.10` collided with a separate `X.1.wav`.
Those regions drew their waveform from a file of a different length, which ran
out partway through the region — `kadenic_sounddesign_layered-input_C.10`
resolved by name to a 9.95 s file instead of its real 16.27 s one. Name matching
is gone; the pointer resolves 12,384 of 12,385 placed regions. `djpubichair.logicx` has eleven records under oid 168 — ten
untrimmed at 717,559 samples and one trimmed to 269,085 with an 89,695-sample
trim-in. Joining on the oid alone took an untrimmed sibling, so a region trimmed
to bars 82-85 drew full length from 82 to 90. 26 oids in that project are
affected; across the corpus fixing this cut audio regions overlapping on a lane
from **21.2% to 6.8%** of adjacent pairs.

**The marker is a u16, not a u32.** Bytes `+2..3` hold a fraction of a tick,
because audio can be dropped at any sample and a tick is 1/960 of a beat. Reading
the marker as a u32 required those bytes to be zero, which silently dropped
**every off-grid region — 1,402 placements** across the corpus. They carry the
full placement structure at exactly the same rate as on-grid ones (85% in both
groups) and never duplicate one. `djpubichair.logicx` went from 1,641 audio
regions to 1,860. The same applies to MIDI placements.

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

### Flex — solved, from the audio file

`+48` bit 7 is **Flex on**. Established with `djpubichair.logicx`, whose "key"
track holds 28 copies of one loop: its user set exactly the last two to flex
off, and those are the only two with the bit clear (`0x17` against `0x97`).

**The stretched length is not stored in the project.** Diffing flex-on against
flex-off copies of the same loop, the placement differs only in that bit, and
the region record only in a modification timestamp (`+76`) and a v1 UUID
(`+200`). Logic works the length out at playback from the audio's own tempo,
which it writes into the audio file as a `LIST/adtl` label ("Tempo: 110.0").
`src/main/audio/fileTempo.ts` reads that label by walking chunk headers only.

That label is rounded — `key3.wav` says 110.0 where its length implies 110.86 —
so it only says roughly how many beats the loop holds. A flexed loop plays as a
**whole number of beats** at project tempo: 4.3297 s at 110 BPM is 7.94 beats,
rounding to 8 = exactly 2 bars, which is what the user sees. Without rounding
the continuous ratio gives 1.984 bars.

The region then needs a **source rate** (audio seconds per timeline second,
1.0644 for `key3`) or its waveform stops short of or overruns the region.

Coverage is partial, and that seems correct rather than a gap: of 4,552 flex-on
placements, 1,023 have a file tempo and 436 resolve to whole beats. A file with
no tempo cannot be stretched by Logic either, so it stays at native length.
Checked across the corpus, stretching cut flex-on regions overlapping their
neighbour from 595 to 564; `djpubichair` went 24 → 7. The one apparent
regression (`skeletons`) was a correctly stretched 4-beat loop touching a
neighbour placed 0.02 beats early.

Two traps worth recording. A float32 search for the stretch ratio found two
hits exactly 80 bytes apart, which looked like a per-placement field; they
straddled the marker and position bytes of two units and were coincidence (a
third read 3.499). And in the renderer, a new local `rate` shadowed the peak
pyramid's `rate`, which would have broken every waveform; it is `sourceRate`.

### MIDI placement — solved

MIDI regions are placed by the SAME 80-byte record, with marker **`0x20`**
instead of `0x24`, and the region ref in a **different slot**: `+8` (mirrored at
`+32`) where audio uses `+44`. Position (`+4`, origin 34560), track ref (`+16`)
and track number (`+20`) are shared. The ref matches a region cell's `oid`, and
that cell supplies the name, the length and the offset of the note block.

**Cell oids collide here too**, but far less: only 15 of 2,099 MIDI placements
(0.7%) land on an oid shared by cells of differing length, and no equivalent of
the audio `+40` ordinal has been found for MIDI. Those 15 may pick the wrong
length.

**Notes must be clipped to their region.** A note block holds the region's full
CONTENT, which can outlast the region: trimming the end leaves the trimmed-off
notes in the block, and they were all being drawn. 194 of the 2,047 MIDI regions
in the corpus had notes running past their end, by up to 10 bars. Only the end
needs clipping — nothing in the corpus starts before its region, and no cell
field matches the first note's offset, so notes that begin late are genuine rests
rather than a start-trim needing a shift.

**This fixed a real rendering bug.** MIDI regions used to take their position
and length from `scanRegionCells` directly, but that scan also returns pool and
take entries whose fields are not timeline values: `mega_test.logicx` yields
cells at tick 0 claiming to be 2000 bars long, named "Untitled", on track ref 0.
The visible symptom was regions starting at the wrong time and overlapping — its
track-1 regions came out every 2 bars with 4-bar lengths, a 50% overlap, where
the arrangement records give a clean 4-bar grid matching its `WindowImage.jpg`.
Across the whole library **MIDI region overlap went from widespread to 0 of
1,756 same-lane pairs.**

Audio still overlaps on 6.8% of same-lane pairs. That looks genuine: every
(track, position) pair is distinct, so these are layered or comped takes rather
than duplicate placements.

### Track mute — solved

`OCuA + 126` is 1 when a track is muted, 0 otherwise, matched to a track via the
strip UUID that `resolveTrackChannelsByRef` already uses. Established with
re_probe8, which mutes exactly tracks 2 and 3: the flag is set on those two and
on no channel of re_probe6 or re_probe7, which mute nothing. A rival candidate at
`+117` bit 3 was **rejected** — it fires on the unmuted probes too.

### Region mute and fades — solved

Three probes, all built on re_probe5 (three audio regions on one track, 120 BPM):

| Probe | Edit | Byte evidence |
|---|---|---|
| 12 | region 2 muted | its unit `+15`: `0x00` → `0x81` |
| 13 | 1-bar fade-in on region 1, 3-bar fade-out on region 3 | unit `+76` u16 = 1999, unit `+72` u16 = 5995 |
| 14 | those fades set to ease in / ease out; a MIDI track with a region at bar 5 and an identical **muted** copy at bar 13 | `+79` = 98, `+75` = 99; the muted MIDI unit has `+8` = 0 |

**Audio mute is `+15` bit 0.** Bit 7 of the same byte is set on a merely
*selected* region (re_probe13 reads `0x80` there), so test the bit, not the
byte. Across ~/Music/Logic it is set on 2 of 13,797 placements.

**Fades are u16 milliseconds, each followed a byte later by an i8 curve**
(-99..99, 0 linear): fade-out at `+72` with its curve at `+75`, fade-in at `+76`
with its curve at `+79`. 1999 and 5995 are 2 s and 6 s as dragged — one and
three bars at 120 BPM. Across the corpus 2,223 placements have a fade-in and
3,237 a fade-out; all but 12 fit inside their region (those are clamped). The
commonest value is a 17 ms fade-out — Logic's anti-click fade. Logic's exact
curve taper is not decoded; the renderer uses a power curve of the same shape.

**MIDI mute clears `+8` and keeps `+32`.** The parser used to require the two
refs to agree, so it silently **dropped every muted MIDI region** (26 across the
corpus, re_probe14's included). A per-track record at bar 1 has the same shape
(`+8` = 0, `+32` set), but its `+32` names no region cell, so the cell join
drops it; the four that did land on a cell were nameless, noteless and
near-zero length, and a one-sixteenth minimum length rejects them.

**But Logic Pro 11 moved MIDI mute onto the definition too** — the region cell's
padded-name-end `+0x4e` bit 0. djpubichair's three "Gentle Sine Bells" copies
muted at bar 65 (tracks 27/28/30) keep `+8` = `+32` on the placement (so the
old test sees them unmuted) and instead set `+0x4e` bit 0 on their cells; only 5
of the project's 301 cells carry it. The parser marks a MIDI region muted if
**either** the placement (`+8` = 0) or the cell (`+0x4e` bit 0) says so — the
exact mirror of the audio mute's two locations.

### Region reverse — solved

**Audio reverse is `+48` bit 5 (`0x20`)** — the same flags byte that carries Flex
at bit 7. Established from `djpubichair.logicx`'s "crash" track: fifteen
placements are cut from one file (`AuRg` ref 184), and the owner reversed exactly
the copies at bars 8, 24, 32, 48, 64, 72, 104. Those seven read `0x3c` at `+48`
against the forward copies' `0x1c` — a clean single-bit difference with the file,
trim-in and length all identical, so it is the reverse toggle and nothing else.
Across the project the bit is set on 245 of 1,871 placements (~13%; this is a
heavily reversed glitch project). The bit is independent of Flex (bit 7).

The reversed copies also carried a clip gain and a fade the forward ones lacked,
but those co-vary only because the owner mixed the reverse-swells that way; they
are not part of the reverse encoding. Reverse is decoded but has no bearing on a
region's position or length — only the renderer mirrors the waveform.

### Region mute, take two — the definition carries it in Logic Pro 11

`+15` bit 0 (above) is a genuine audio-mute flag in re_probe12, but it is set on
**none** of djpubichair's muted regions: its `kick 2` copies muted at bars 67–72
are byte-identical to the unmuted ones across the whole 80-byte placement unit.
Real projects keep region mute on the **definition**, not the placement:

**Audio mute is also `AuRg` (`gRuA`) `+41` bit 1 (`0x02`).** Established by
un-muting eight `kick 2` copies (bars 65–72) in djpubichair and diffing the save:
exactly those eight AuRg records cleared `+41` bit 1 and nothing else in the file
did, taking the project's muted count from 262 to 254. The placement bytes only
changed in their *selection* flag (`+15` bit 7), which is why the muted and
unmuted placements looked identical — the mute was never there. `+41` also holds
unrelated bits (`0x01`, `0x40`, `0x80`) that vary independently.

Because each placement joins to its own AuRg (via `regionRef` + ordinal), a
per-definition flag is still effectively per-placement. The parser marks a region
muted if **either** location is set — `+15` bit 0 for re_probe12 and older
projects, `+41` bit 1 for Logic Pro 11.

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

- **Region loops.** In `djpubichair.logicx` the "outro drums" track shows a
  region from bar 109 to bar 111 3.2.181, but no placement record exists for
  that track anywhere between bar 105 and 111.6 — the records at bar 109's tick
  all belong to other tracks. The bar-105 region's audio ends at 108.52, so the
  likeliest explanation is that it is LOOPED and 109-111.61 is a loop repeat.
  That is unconfirmed: its placement record is byte-identical to an ordinary one
  apart from position and ordinal, so the loop flag, if that is what it is,
  lives elsewhere. A probe that loops one region would settle it.
- **MIDI region selection when cell oids collide** — 0.7% of placements. Audio
  solves this with the placement's `+40` ordinal; MIDI has no known equivalent.
- **MIDI start-trim**, if it exists. No region in the corpus has notes starting
  before it, so there is nothing to shift, but a probe that trims a MIDI
  region's START would confirm whether a content offset is stored anywhere.
- **Which track an automation lane belongs to.** The parameter is known
  (`0x07` volume, `0x0a` pan) and lanes are separated, but nothing yet ties a
  lane to its track, so a project with automation on several tracks produces
  lanes that cannot be attributed. `arp swell beat.logicx` yields 8 lanes with
  no way to say whose they are.
- **Plugin-parameter automation.** Only ids `0x07` and `0x0a` have been seen; a
  probe automating a plugin parameter would show whether those ids extend.


### Tempo — solved

Tempo records use the **38400** origin (the song-start record confirms it).

**The tempo list has no fixed stride.** 32-byte tempo records are interleaved
with 16-byte meta chunks (first byte `0x00`, a marker such as `0xb1`/`0xb4` at
`+7`) — the same gotcha Texture documented for MIDI note blocks. Texture's
`findTempoLists` walked a fixed 32 bytes, lost sync after the first meta chunk,
and silently dropped every later tempo change: `djpubichair.logicx`'s ramps
(118 BPM to bar 97 beat 4, easing to 125 at bar 100 beat 4, then 134 at bar 103
beat 4) decoded as one 118 BPM event. The vendored copy now walks at 16-byte
granularity and consumes 32 only for a record that validates. The second half of
a record also begins with `0x60` (the tempo value's low byte), but reads as an
enormous position, which rejects it. djpubichair now yields 50 events; no other
project's count changed.

Further findings:

- Logic bakes **tempo curves into dense discrete events** — `arp swell beat` has
  130 events at 240-tick (1/16-note) spacing ramping 89 → 89.1 → 89.15 BPM. So
  treating each event as a step is accurate, not an approximation.
- The `0x60` status scan yields **false-positive lists** in 5 of 50 projects
  (`sixeight.logicx`: 5 lists, 11 events, 1 real; the fakes sit near tick 2^31 at
  ~1.6 BPM). `selectTempoEvents()` in `src/main/project/tempoSelect.ts` picks the
  list containing the song-start event and filters implausible records.
