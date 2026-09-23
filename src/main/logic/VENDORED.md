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
| `trackTree.ts` | **new.** Texture walks the same track nodes but reads no stack fields |

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

### Track stacks — solved

**The arrange track list is the song-root folder.** It is the type-`0x17` `qeSM`
cell named after the project, holding one 94-byte `karT` node per track in
Logic's order, with the output strip's node last. (The "Track Automation Root
Folder" holds `karT` nodes too, one per strip, in no useful order.)

| Offset | Meaning |
|---|---|
| `+18` u32 | ordinal: **track number − 1**, exactly as the track header shows it |
| `+28` u32 | payload **58** — or **57** in older projects, same layout one byte short |
| `+36` u16 | node type: `1` almost always, `3` the output strip (not a track), `5` a second track on an already-used strip; `6` and `10` also occur and are real tracks |
| `+44` u32 | strip ref (the `ivnE` id, and the placement's `+16` track ref) |
| `+50` u8 | **stack depth**: 0 top level, 1 in a stack, 2 in a nested stack |
| `+76` u8 | **bit 6 = stack head** (the stack's main track); **bit 7 = expanded**, meaningful only on a head |

The list is flat: a stack is its head followed by the run of tracks one level
deeper. Established from `djpubichair.logicx`, whose owner listed all six
summing stacks by track number from Logic's headers. Every track number and all
41 members matched, and so did the tracks just after each stack (9, 14, 24, 31,
53), which sit at depth 0. `limbo.logicx`'s WindowImage confirms nesting and bit
7. "Sum 18" (`0xc0`, open) holds two "Natural Finger Pick" stacks (`0x40`, both
drawn collapsed), each holding three depth-2 tracks.

Across ~/Music/Logic: all 61 projects yield a list (103 stack heads, 560
members), every member sits exactly one level below its head, and a placement's
`+20` track number names the same strip as the list in **15,865 of 15,868**
placements. Three in `i love crack.logicx` disagree; they resolve by strip ref.

The old ordering came from `listLogicTracks`. It demanded payload 58, so it
refused the 18 older-format projects outright. It kept only node type 1, which
dropped limbo's two "Brit and Clean" tracks (type 10) and renumbered everything
after them. And any strip it did not list took `tracks.length` as its index,
which collided with real ordinals and put Stereo Out and Master among the first
tracks. That walk is now only a fallback. Where the song-root list exists, it
defines which tracks exist, so strips it does not list (Stereo Out, Master, aux
strips with no arrange track) are no longer tracks: djpubichair goes from 62
"tracks" to its real 57.

**Two tracks can share one strip.** `dark.logicx` tracks 2 and 3, and `keshi beat
v33`'s 50 and 51, name the same strip; the second has node type 5. They get
separate ids, and a placement joins on strip ref *and* track number.

### Summing and buses — the mixer routing

A summing stack's head is an **Aux** channel, and its members output to the bus
that Aux listens to. On the `OCuA` channel record:

| Offset | Meaning |
|---|---|
| `+0x80` u16 | output: **0 = Stereo Out**, N = Bus N |
| `+0x82` u16 | input: on an Aux, the **bus it listens to**; on an audio channel, the hardware input; `0xffff` none |

In djpubichair, "lead" is Aux 4, listening to Bus 4, and its members output to
Bus 4. The same holds for outro (Aux 10 on Bus 9), instrumentals (Aux 3 on
Bus 3), bass sum (Aux 6 on Bus 6), sfx (Aux 5 on Bus 5) and drums (Aux 2 on
Bus 2). Across the corpus 90 of 103 heads are Aux channels, and **543 of 560**
members output to their head's input bus. The exceptions are genuine:

- djpubichair's **track 7 "Soft Cinematic"** sits in the lead stack but outputs
  to **Stereo Out**, as its channel inspector in the WindowImage shows. It reaches
  the stack only through a **Bus 1 send** to track 8.
- **Track 8 "Large Hall/Concert Hall" is an aux track** (the "bus" in the
  owner's list): **Aux 1, listening to Bus 1, outputting to Bus 4**, so the
  reverb return is summed into "lead". Aux tracks are ordinary nodes in the list;
  their channel is what makes them an aux.
- `synth thingy*` put reverb aux returns inside stacks while they output to
  Stereo Out, like track 7.
- The 12 non-Aux heads are **audio tracks**: the per-stem tracks ("(Vocals)",
  "(Drums)", …) inside the stem-splitter stacks of `justinbiebreb` and
  `smthidk`. They are stacks within a summing stack. The remaining head,
  `lucas.logicx`'s Drum Machine Designer "Empty Kit", matches no channel.
- Channel-strip patches build summing stacks too. `test chords`'s "Heavenly
  Tweed" (node type 10) is an Aux head over the recording track ("Amp") and
  an effect aux ("Heavenly Mod"), all on Bus 5.

**Stack mute and automation reach the tracks routed into it.** A summing
stack's mute is simply its Aux channel's mute (`OCuA +126`), and its volume
automation is an ordinary lane on the head's strip. djpubichair's owner muted
"sfx" and automated "drums", and both decode with no new fields. Logic applies
them to everything summed through that Aux, so the model does too, by following
the **routing** rather than stack membership. Each channel is heard through
every Aux its output feeds, hop by hop to Stereo Out. `TrackModel.muted` is true
when any channel on that path is muted, and `mutedBy` names which. `volume`
combines every fader on the path (gains multiply, so fader = 90 · Π(v/90)), and
`ownVolume` keeps the track's own lane. Routing is what makes track 7
right: it sits in "lead" but outputs to Stereo Out, so lead's automation does
not reach it, while the reverb aux on track 8 (output Bus 4) is heard through
lead. A track whose channel is unknown falls back to its stack's main track.
Across the corpus, 69 tracks are silenced by a stack upstream and 100 are heard
through someone else's volume lane.

**A channel UUID can contain `0xff`.** Strips join to channels by the channel's
UUID, found after an `0xff` byte. The old scan kept the *last* `0xff` + 16
bytes, and when the UUID itself contained `0xff` that window started inside it,
so the join failed. djpubichair's Inst 7 is `d2166f96…45ff690f09`, so
"Vintage Silk Motion" had no channel and lost its mute (57 channels in the
corpus). The field is not at a fixed offset either (channel end − 49 holds for
only half), so every candidate is kept and the strip picks the real one.

**Strip names are length-prefixed**, u16 at `ivnE +0xc2` with the name after it,
not null-terminated. Reading `+0xc4` as a C string ran into the next field
("lead lullabyC", "Liquid CrystalD"). Stripping trailing digits to tidy that
turned "glitch 1" into "glitch" and "kick 2" into "kick". 332 of 1,178 track
names across the corpus changed, all toward what Logic shows.

### Region mute and fades — solved

Three probes, all built on re_probe5 (three audio regions on one track, 120 BPM):

| Probe | Edit | Byte evidence |
|---|---|---|
| 12 | region 2 muted | its unit `+15`: `0x00` → `0x81` |
| 13 | 1-bar fade-in on region 1, 3-bar fade-out on region 3 | unit `+76` u16 = 1999, unit `+72` u16 = 5995 |
| 14 | those fades set to ease in / ease out; a MIDI track with a region at bar 5 and an identical **muted** copy at bar 13 | `+79` = 98, `+75` = 99; the muted MIDI unit has `+8` = 0 (a red herring, see Region transpose) |

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

**MIDI mute clears `+8` and keeps `+32`.** *(Withdrawn: re_probe15 shows an unmuted copy with `+8` cleared; see Region transpose. Kept for the record.)* The parser used to require the two
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

### Flex, take two — the stretched length IS stored

The claim above that the stretched length is not in the project is wrong. After
each audio placement unit Logic writes a run of 80-byte **time-map records**,
tagged `0xaa` at `+7` with a type at `+6`. A **type-3** record maps a sample
count (`+0`, i32) to ticks (`+12` u32, plus a `+10` u16 fraction / 65536); the
one whose samples equal the region's `AuRg +58` length gives the region's
**timeline length**. Types 6 (flex markers), 0x0b (transients), 1, 7 and others
also occur, but they are not decoded.

Found through `bassthing.logicx`'s "guitar thingy scream": one flexed take split
in two, which Logic draws touching at bar 16.5. Its file has no tempo label, so
the file-tempo estimate left the first half at native length, 0.7 bar short.
Its time map ends 382999 samples → 20160 ticks = 21 beats, bars 11.25 → 16.5.

Across ~/Music/Logic, 5,142 of 5,318 flex-on placements have a matching type-3
record. Where it disagrees with the file-tempo estimate (739), the estimate
overlaps the next region on its lane 142 times and the anchor once, and the
anchor abuts the next region exactly more often (113 vs 88). The whole-beats
rounding was the estimate's main error: hi-hat rolls come out 0.500 / 0.625
beats, not 0.725. The file-tempo path remains only as a fallback.

### Region transpose — solved

**Transpose is placement `+53`, an i8 in semitones, for MIDI and audio
alike.** re_probe15 is re_probe5 with audio region 1 set to +5 (Flex on), plus a
MIDI track with a region at bar 1 and a copy at bar 11 set to -7. The audio unit
reads `0x05` at `+53`, the MIDI copy `0xf9`, and every other placement 0.
Logic applies it at playback and leaves the stored notes alone, so
`buildProject` adds it to each MIDI note's pitch and the roll draws what the
bounce plays. Logic's own label is "Deluxe Classic (-7)"; `regionLabel()` matches it.

**A stale copy in the region cell misled the first attempt.** The cell's
padded-name-end `+0xa1` also holds transpose-shaped values: 0 on 95% of the
corpus, otherwise mostly octaves. It agrees with `+53` on about 97% of
placements, so a corpus hunt picked it. But it reads **0** on re_probe15's -7
copy, and disagrees on about 60 corpus placements (`12/0`, `0/12`,
`24/12`, …). It is not read.

**The same probe overturned MIDI "mute = `+8` cleared".** The -7 copy is
unmuted (the inspector's Mute box is clear in its WindowImage) yet has `+8` = 0.
re_probe14's muted copy also carries the cell mute flag (`+0x4e` bit 0), and only
1 of the 27 corpus placements with `+8` cleared has a muted cell. MIDI mute is
now the cell flag alone; `+8` = 0 is still accepted as a placement, and its
meaning is unknown.

Track-level transpose (track inspector) is a separate parameter, not decoded.

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

**Other rows are interleaved, as in the tempo list.** Real lists carry
`0x0051` records (a float32 at `+8`, likely plugin-parameter automation, not
decoded) and meta rows whose first six bytes are zero. Requiring every row to be
`0x0050` rejected those chunks whole: `bassthing.logicx` lost all five of its
volume lanes, and across ~/Music/Logic the walk now finds 95 lanes instead of 34
(69 volume instead of 31), every one attributed to a real track strip. Positions
also carry a sub-tick fraction at `+2` (u16 / 65536), as on placements.
bassthing's "guitar thingy scream" decodes to 0 dB at 16 3 1 0, -inf at 16 3 1 18,
held to 16 3 2 196 and eased back to 0 dB at bar 17, matching its arrange view.

**That was still too strict.** Rows in an automation list come from a whole
family of markers: `0x50`-`0x58` (the `0x51`+ ones float-valued, mostly with
parameter id `0x1d`, likely plugin parameters), `0x8050`, and in djpubichair
`0xe0`. None of these is decoded. Any of them outside `0x51` still rejected the
chunk, which dropped **27 of the 96** volume-bearing lanes. One was the lane its
owner drew on djpubichair's "drums" stack (0 dB at bar 25 to -inf at bar 41,
2,924 points), which shares its chunk with 182 rows of marker `0x54`. Inside a
chunk known to be automation, because its cell is named `*Automation`, every
row that is not `0x50` is now skipped. All 96 lanes decode, and all stay in time
order. A chunk NOT known to be automation keeps the strict rule, since it may be
some other 16-byte structure.

**Each lane belongs to the track named by its sequence's region cell.** An
automation list is stored like a MIDI region: a cell named `*Automation` whose
qSvE *is* the automation chunk, with the track ref at qSvE - 111 like any
other cell (`attributeAutomationLanes()`). All 34 lanes in ~/Music/Logic sit in
such a cell and resolve to a real track strip, with no track carrying two lanes
of one parameter. `arp swell beat`'s eight land on four of its "Bright Synth
Lead" layers (the swells), the 808 bass, a reverb aux, and "guitar feedback
thing" (volume and pan). Only ids `0x07` and `0x0a` occur, so there is no pitch
or plugin automation to decode yet.

The fader taper is calibrated only at 90 = 0 dB and 0 = -inf. `faderToDecibels()`
uses the MIDI volume law, 40·log10(v/90), which fits both and gives the fader's
+6 dB ceiling at 127. It is confirmed at a third point: bassthing's Aux 3 lane
stores 58.8, and Logic displays it as -7.4 dB, which is what the law gives.

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
- **Sends.** Soft Cinematic's Bus 1 send is visible in its WindowImage but is
  not decoded; a probe adding one send to one channel would find it.
- **Folder stacks.** Every stack in the corpus is a summing stack or an
  audio-track head; no plain folder stack exists to show whether a `+76` bit
  tells the two apart. `StackModel.summing` is derived from the head being an
  Aux instead. A probe with one folder stack and one summing stack would settle it.
- **Hardware outputs.** Only Stereo Out (0) and buses have been seen at `+0x80`.
  Routing to "Output 3-4" may reuse the same numbers.
- **Node types 6 and 10** are real tracks, but what makes them different is not
  known.
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
