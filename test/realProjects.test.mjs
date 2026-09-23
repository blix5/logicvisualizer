import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProjectModel } from '../.test-build/buildProject.mjs';
import { regionLabel } from '../.test-build/model.mjs';
import { buildTempoMap, beatsToSeconds, secondsToBeats } from '../.test-build/timebase.mjs';
import { faderAt } from '../.test-build/automation.mjs';

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

      // When the arrange list is found it numbers every track 1..n, and each
      // stack member sits exactly one level below a stack head.
      if (model.tracks.some((t2) => t2.number !== null)) {
        model.tracks.forEach((track, i) => assert.equal(track.number, i + 1, `${track.name} is track ${i + 1}`));
        const byId = new Map(model.tracks.map((t2) => [t2.id, t2]));
        for (const track of model.tracks) {
          if (track.depth === 0) { assert.equal(track.parentId, null); continue; }
          const parent = byId.get(track.parentId);
          assert.ok(parent?.stack, `${track.name}'s parent is a stack head`);
          assert.equal(parent.depth, track.depth - 1);
          assert.ok(parent.number < track.number, 'a member follows its head');
        }
      }

      for (const file of model.audioFiles) {
        if (file.absolutePath) assert.equal(typeof file.exists, 'boolean');
      }

      // MIDI regions must not overlap on a lane. They used to, badly: taking
      // position from the region cells rather than the arrangement placements
      // put mega_test's regions every 2 bars with 4-bar lengths.
      const lanes = new Map();
      for (const region of model.regions) {
        if (region.kind !== 'midi') continue;
        const lane = lanes.get(region.trackId);
        if (lane) lane.push(region); else lanes.set(region.trackId, [region]);
      }
      for (const lane of lanes.values()) {
        lane.sort((a, b) => a.startSeconds - b.startSeconds);
        for (let i = 1; i < lane.length; i += 1) {
          assert.ok(
            lane[i - 1].endSeconds - lane[i].startSeconds <= 0.01,
            `${name}: MIDI regions overlap on one lane`,
          );
        }
      }
    });
  }
});

test('flex-on regions are stretched to their musical length', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // djpubichair's "key" track holds 28 copies of one loop. Flex-on copies must
  // be exactly 2 bars; any flex-off copy keeps its native 2.1288. The count of
  // each is NOT asserted: this is a live project its owner edits, and the flex
  // state of individual regions has changed between saves.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const key = model.tracks.find((t) => t.name === 'key');
  assert.ok(key, 'found the key track');
  const regions = model.regions.filter((r) => r.trackId === key.id);
  assert.equal(regions.length, 28);

  // Bars are measured through the tempo map, not the base tempo: this project
  // has tempo changes, so a fixed 118 BPM bar length would be wrong later on.
  const tempo = buildTempoMap(model.tempoEvents, model.baseBpm);
  const bars = (r) => (secondsToBeats(tempo, r.endSeconds) - secondsToBeats(tempo, r.startSeconds)) / 4;

  let flexOn = 0;
  for (const r of regions) {
    if (r.flex) {
      flexOn += 1;
      assert.ok(Math.abs(bars(r) - 2) < 0.001, `${r.name} (flex on) is exactly 2 bars, got ${bars(r).toFixed(4)}`);
      assert.ok(r.sourceRate > 1, `${r.name}: its audio is sped up to fit`);
    } else {
      assert.ok(Math.abs(bars(r) - 2.1288) < 0.001, `${r.name} (flex off) keeps its native length`);
      assert.equal(r.sourceRate, 1);
    }
  }
  assert.ok(flexOn > 0, 'at least one flex-on region to check');
});

test('reversed audio regions decode from the +48 flag', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // djpubichair's "crash" track holds one cymbal cut placed many times; the
  // owner reversed exactly the copies at bars 8, 24, 32, 48, 64, 72, 104. Those
  // seven set +48 bit 5 while the forward copies do not, with the source file
  // and trim identical -- the clean split that established the reverse flag.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const crash = model.tracks.find((t) => t.name === 'crash');
  assert.ok(crash, 'found the crash track');
  const bar = (r) => Math.round(r.startBeat / 4) + 1;
  const reversedBars = model.regions
    .filter((r) => r.trackId === crash.id && r.kind === 'audio' && r.reversed)
    .map(bar)
    .sort((a, b) => a - b);
  assert.deepEqual(reversedBars, [8, 24, 32, 48, 64, 72, 104]);
});

test('muted audio regions decode from the AuRg definition', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // Real projects (Logic Pro 11) store region mute on the definition (AuRg +41
  // bit 1), not the placement's +15, so the placement-only check saw none of
  // djpubichair's ~260 muted regions. The exact count shifts as the owner edits,
  // so this asserts the detection works at all rather than a brittle total.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const mutedAudio = model.regions.filter((r) => r.kind === 'audio' && r.muted);
  assert.ok(mutedAudio.length >= 100, `many muted audio regions are detected (${mutedAudio.length})`);
});

test('muted MIDI regions decode from the region cell', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // MIDI mute also moved to the definition (region cell +0x4e bit 0) in Logic
  // Pro 11: three "Gentle Sine Bells" copies muted at bar 65 (on the bass synth
  // hit / bass / bass high accent tracks) keep +8 = +32 on the placement, so the
  // old placement-only check saw them unmuted. bar N starts at beat (N-1)*4.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const bar = (r) => Math.round(r.startBeat / 4) + 1;
  const mutedAtBar65 = model.regions.filter((r) => r.kind === 'midi' && r.muted && bar(r) === 65);
  assert.equal(mutedAtBar65.length, 3, 'the three bar-65 bass MIDI regions are muted');
  assert.ok(mutedAtBar65.every((r) => r.name === 'Gentle Sine Bells'));
});

test('tempo changes and curves are decoded', { skip: (() => {
  const r = process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic');
  return !fs.existsSync(path.join(r, 'djpubichair.logicx')) && 'djpubichair.logicx not found';
})() }, () => {
  // 118 BPM to bar 97 beat 4, easing to 125 at bar 100 beat 4, then 134 at bar
  // 103 beat 4. Tempo records are interleaved with 16-byte meta chunks, so a
  // fixed-stride walk found only the first event.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const events = model.tempoEvents;
  assert.ok(events.length > 10, `the curve's intermediate points are present (${events.length})`);
  const at = (bar, beat) => {
    const target = (bar - 1) * 4 + (beat - 1);
    return events.reduce((a, b) => (Math.abs(b.beat - target) < Math.abs(a.beat - target) ? b : a));
  };
  assert.equal(events[0].bpm, 118);
  assert.equal(at(97, 4).bpm, 118);
  assert.equal(at(100, 4).bpm, 125);
  assert.equal(at(103, 4).bpm, 134);
  // The ramp between them eases rather than stepping straight to the target.
  const ramp = events.filter((e) => e.beat > (96 * 4 + 3) && e.beat < (99 * 4 + 3));
  assert.ok(ramp.length > 5, 'intermediate points between anchors');
  assert.ok(ramp.every((e, i) => i === 0 || e.bpm >= ramp[i - 1].bpm), 'monotonic ramp');
});

const probe = (name) => path.join(process.env.LV_PROJECTS_DIR ?? path.join(os.homedir(), 'Music', 'Logic'), `${name}.logicx`);

test('region mute and fades decode from the probes that isolate them', {
  skip: !['re_probe12', 're_probe13', 're_probe14'].every((n) => fs.existsSync(probe(n))) && 're_probe12-14 not found',
}, () => {
  // re_probe12: only the second of three regions is muted.
  const muted = buildProjectModel(probe('re_probe12')).regions.map((r) => r.muted);
  assert.deepEqual(muted, [false, true, false]);

  // re_probe13: 1-bar fade-in on region 1, 3-bar fade-out on region 3, at 120 BPM.
  const fades = buildProjectModel(probe('re_probe13')).regions
    .map((r) => [Math.round(r.fadeInSeconds), Math.round(r.fadeOutSeconds)]);
  assert.deepEqual(fades, [[2, 0], [0, 0], [0, 6]]);

  // re_probe14: the same fades eased, and a muted MIDI copy at bar 13.
  const model = buildProjectModel(probe('re_probe14'));
  const audio = model.regions.filter((r) => r.kind === 'audio');
  assert.ok(audio[0].fadeInCurve > 0.9 && audio[2].fadeOutCurve > 0.9);
  const midi = model.regions.filter((r) => r.kind === 'midi');
  assert.deepEqual(midi.map((r) => [Math.round(r.startSeconds), r.muted]), [[8, false], [24, true]]);
});

test('region transpose decodes from the placement, for MIDI and audio', {
  skip: !fs.existsSync(probe('re_probe15')) && 're_probe15 not found',
}, () => {
  // re_probe15: re_probe5 with audio region 1 at +5 (Flex on), plus a MIDI
  // region at bar 1 and a -7 copy at bar 11. Logic labels it "Deluxe Classic (-7)".
  const model = buildProjectModel(probe('re_probe15'));
  const audio = model.regions.filter((r) => r.kind === 'audio');
  assert.deepEqual(audio.map((r) => r.transposeSemitones), [5, 0, 0]);
  const midi = model.regions.filter((r) => r.kind === 'midi');
  assert.deepEqual(midi.map((r) => [Math.round(r.startSeconds), r.transposeSemitones, r.muted]), [[0, 0, false], [20, -7, false]]);
  assert.deepEqual(midi.map(regionLabel), ['Deluxe Classic', 'Deluxe Classic (-7)']);
  // The copy's notes sound 7 semitones lower; the stored block is identical.
  const pitches = (r) => Array.from({ length: r.noteCount }, (_, i) => r.notes[i * 4 + 2]);
  assert.deepEqual(pitches(midi[1]), pitches(midi[0]).map((p) => p - 7));
});

test('volume automation lands on the track that owns it', {
  skip: !fs.existsSync(probe('re_probe9')) && 're_probe9 not found',
}, () => {
  // re_probe9's one edit is a volume ramp, 0 dB at bar 1 to -inf at bar 21, on
  // a single track; 120 BPM puts bar 21 at 40 s.
  const model = buildProjectModel(probe('re_probe9'));
  const automated = model.tracks.filter((t) => t.volume);
  assert.equal(automated.length, 1, 'exactly one track carries it');
  const { seconds, fader } = automated[0].volume;
  assert.equal(fader[0], 90);
  assert.equal(fader[fader.length - 1], 0);
  assert.ok(Math.abs(seconds[seconds.length - 1] - 40) < 0.1, `ends at 40 s (${seconds[seconds.length - 1]})`);
  assert.ok(model.regions.some((r) => r.trackId === automated[0].id), 'the automated track has regions');
});

test('a flexed region takes its stretched length from the placement time map', {
  skip: !fs.existsSync(path.join(root, 'bassthing.logicx')) && 'bassthing.logicx not found',
}, () => {
  // "guitar thingy scream": one flexed take split in two. Logic draws the first
  // from bar 11.25 to 16.5, touching the second. Its file has no tempo label,
  // so only the stored time map (382999 samples -> 20160 ticks) gets this right.
  const model = buildProjectModel(path.join(root, 'bassthing.logicx'));
  const guitar = model.regions
    .filter((r) => r.kind === 'audio' && r.name.startsWith('freesound_community-guitar-feedback-25606_1.'))
    .sort((a, b) => a.startBeat - b.startBeat);
  const bar = (beat) => beat / 4 + 1;
  assert.equal(bar(guitar[0].startBeat), 11.25);
  assert.equal(bar(guitar[0].startBeat + guitar[0].lengthBeats), 16.5);
  assert.equal(bar(guitar[1].startBeat), 16.5, 'the second half starts where the first ends');
  assert.ok(guitar[0].sourceRate < 1, 'the audio is stretched to fill it');
});

test('volume lanes interleaved with other rows still decode', {
  skip: !fs.existsSync(path.join(root, 'bassthing.logicx')) && 'bassthing.logicx not found',
}, () => {
  // "guitar thingy scream" is drawn in Logic as 0 dB at 16 3 1 0, -inf by
  // 16 3 1 18, held to 16 3 2 196, easing back to 0 dB at bar 17. Its chunk
  // interleaves float records and meta rows, which used to reject it outright.
  const model = buildProjectModel(path.join(root, 'bassthing.logicx'));
  const guitar = model.tracks.find((t) => t.name === 'guitar thingy scream');
  assert.ok(guitar?.volume, 'the track has its volume lane');
  const at = (bar, beat, sixteenth, tick) => {
    const beats = (bar - 1) * 4 + (beat - 1) + (sixteenth - 1) / 4 + tick / 960;
    return beats * 60 / model.baseBpm;
  };
  const faderAt = (seconds) => {
    const { seconds: t, fader } = guitar.volume;
    let i = 0;
    while (i + 1 < t.length && t[i + 1] <= seconds) i += 1;
    return fader[i];
  };
  assert.equal(faderAt(at(16, 3, 1, 0)), 90, '0 dB where the dip starts');
  assert.equal(faderAt(at(16, 3, 2, 100)), 0, '-inf through the hold');
  assert.ok(faderAt(at(16, 4, 3, 0)) > 20 && faderAt(at(16, 4, 3, 0)) < 90, 'easing back up');
  assert.equal(faderAt(at(17, 1, 1, 10)), 90, 'back to 0 dB at bar 17');
});

test('summing stacks decode from the arrange list', {
  skip: !fs.existsSync(path.join(root, 'djpubichair.logicx')) && 'djpubichair.logicx not found',
}, () => {
  // Ground truth is the owner's reading of Logic's track headers: six summing
  // stacks, each member listed by track number. Track 7 is in the lead stack
  // but its output is Stereo Out, which its channel inspector confirms; it
  // reaches the stack only through its Bus 1 send to track 8's reverb aux.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const byNumber = new Map(model.tracks.map((t) => [t.number, t]));
  const stacks = {
    1: ['lead', [2, 3, 4, 5, 6, 7, 8]],
    10: ['outro', [11, 12, 13]],
    15: ['instrumentals', [16, 17, 18, 19, 20, 21, 22, 23]],
    26: ['bass sum', [27, 28, 29, 30]],
    32: ['sfx', [33, 34, 35, 36, 37]],
    38: ['drums', [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52]],
  };
  assert.deepEqual(model.tracks.filter((t) => t.stack).map((t) => t.number), [1, 10, 15, 26, 32, 38]);
  for (const [headNumber, [name, members]] of Object.entries(stacks)) {
    const head = byNumber.get(Number(headNumber));
    assert.equal(head.name, name);
    assert.deepEqual(head.stack, { summing: true, expanded: true });
    assert.equal(head.channel.kind, 'aux');
    const found = model.tracks.filter((t) => t.parentId === head.id).map((t) => t.number);
    assert.deepEqual(found, members, `${name} holds tracks ${members.join(', ')}`);
    for (const number of members) {
      const member = byNumber.get(number);
      if (number === 7) continue;
      assert.equal(member.channel.outputBus, head.channel.inputBus, `track ${number} outputs to ${name}'s bus`);
    }
  }
  assert.equal(byNumber.get(7).name, 'Soft Cinematic');
  assert.equal(byNumber.get(7).channel.outputBus, null, 'Soft Cinematic outputs to Stereo Out');
  const hall = byNumber.get(8);
  assert.equal(hall.name, 'Large Hall/Concert Hall');
  assert.deepEqual(hall.channel, { name: 'Aux 1', kind: 'aux', outputBus: 4, inputBus: 1 });
  // Names the old reader mangled: a C-string read ran on past the length, and
  // trailing digits were stripped.
  assert.equal(byNumber.get(33).name, 'glitch 1');
  assert.equal(byNumber.get(9).name, 'Liquid Crystal');
  // Its channel UUID contains 0xff, which defeated the channel join.
  assert.equal(byNumber.get(23).channel?.name, 'Inst 7');
  assert.equal(model.tracks.length, 57, 'Stereo Out, Master and bare aux strips are not tracks');
});

test('nested and collapsed stacks decode', {
  skip: !fs.existsSync(path.join(root, 'limbo.logicx')) && 'limbo.logicx not found',
}, () => {
  // limbo's WindowImage: "Sum 18" (open) holds two "Natural Finger Pick"
  // stacks (both closed), each holding a Natural Finger Pick, Left and Right.
  // Tracks 10 and 11 have node type 10 and used to be dropped from the order.
  const model = buildProjectModel(path.join(root, 'limbo.logicx'));
  const byNumber = new Map(model.tracks.map((t) => [t.number, t]));
  assert.equal(byNumber.get(1).name, 'Sum 18');
  assert.equal(byNumber.get(1).stack.expanded, true);
  for (const head of [2, 6]) {
    assert.equal(byNumber.get(head).parentId, byNumber.get(1).id);
    assert.equal(byNumber.get(head).stack.expanded, false);
    assert.deepEqual(model.tracks.filter((t) => t.parentId === byNumber.get(head).id).map((t) => [t.number, t.depth]),
      [[head + 1, 2], [head + 2, 2], [head + 3, 2]]);
  }
  assert.equal(byNumber.get(10).name, 'Brit and Clean');
  assert.equal(byNumber.get(11).name, 'Brit and Clean');
  assert.equal(byNumber.get(12).name, 'soft piano');
});

test('a stack\'s mute and volume reach the tracks routed into it', {
  skip: !fs.existsSync(path.join(root, 'djpubichair.logicx')) && 'djpubichair.logicx not found',
}, () => {
  // The owner muted the "sfx" stack (32) and drew volume automation on the
  // "drums" stack (38): 0 dB at bar 25 falling to -inf at bar 41.
  const model = buildProjectModel(path.join(root, 'djpubichair.logicx'));
  const byNumber = new Map(model.tracks.map((t) => [t.number, t]));
  const sfx = byNumber.get(32);
  assert.equal(sfx.mutedBy, sfx.id);
  for (const n of [33, 34, 35, 36, 37]) {
    assert.equal(byNumber.get(n).muted, true, `track ${n} is silenced by sfx`);
    assert.equal(byNumber.get(n).mutedBy, sfx.id);
  }
  assert.equal(byNumber.get(31).muted, false, 'the track before the stack is not');

  const drums = byNumber.get(38);
  assert.ok(drums.ownVolume, 'the drums stack has its own lane');
  const tempoMap = buildTempoMap(model.tempoEvents, model.baseBpm);
  const atBar = (bar) => beatsToSeconds(tempoMap, (bar - 1) * 4);
  assert.equal(faderAt(drums.ownVolume, atBar(25)), 90);
  assert.ok(Math.abs(faderAt(drums.ownVolume, atBar(33)) - 45) < 0.5, 'half way down at bar 33');
  assert.equal(faderAt(drums.ownVolume, atBar(41.5)), 0);
  const kick = byNumber.get(39);
  assert.equal(kick.ownVolume, null);
  assert.ok(Math.abs(faderAt(kick.volume, atBar(33)) - 45) < 0.5, 'the kick is heard through it');
  assert.equal(faderAt(kick.volume, atBar(41.5)), 0);

  // "Soft Cinematic" (7) sits in the lead stack but outputs to Stereo Out, so
  // the automation on "lead" (1) does not reach it; the reverb aux (8), which
  // outputs to lead's bus, is heard through it.
  const soft = byNumber.get(7);
  assert.equal(soft.volume, soft.ownVolume);
  const hall = byNumber.get(8);
  assert.notEqual(hall.volume, hall.ownVolume);
  assert.ok(hall.volume.seconds.length >= byNumber.get(1).ownVolume.seconds.length);
});
