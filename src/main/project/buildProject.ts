// Turns a .logicx bundle into the renderer-facing ProjectModel.
// This is the only place the vendored parsers and the new audio parser meet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveLogicPaths } from '../logic/logicPaths';
import { readLogicImage } from '../logic/logicImage';
import { readPlistJson } from '../logic/logicPlist';
import { parseMidiRegions } from '../logic/midiRegions';
import { parseAudioFiles, placedAudioRegions } from '../logic/logicAudio';
import { parseTrackVolumeAutomation } from '../logic/logicAutomation';
import {
  resolveTrackNamesByRef,
  resolveTrackChannelNamesByRef,
  resolveTrackChannelsByRef,
  listTrackStrips,
  type TrackStrip,
} from '../logic/trackNames';
import { readArrangeTree } from '../logic/trackTree';
import { findTempoLists } from '../logic/ops/tempo';
import { selectTempoEvents } from './tempoSelect';
import { findSignatureLists } from '../logic/ops/timeSignature';
import { listTrackMarkers } from '../logic/ops/markers';
import { listLogicTracks } from '../logic/ops/trackObjects';

import {
  buildTempoMap,
  beatsToSeconds,
  secondsToBeats,
  ticksToBeats,
  LOGIC_PPQ,
  type TempoEvent,
  type TimeSignature,
} from '../../shared/timebase';
import type {
  AudioFileModel,
  AudioRegionModel,
  ChannelModel,
  MarkerModel,
  MidiRegionModel,
  ProjectModel,
  RegionModel,
  TrackModel,
} from '../../shared/model';
import { NOTE_STRIDE } from '../../shared/model';
import { combineVolumeCurves, type VolumeCurve } from '../../shared/automation';
import { fallbackTrackColor } from './palette';
import { flexedBeats, readFileTempo } from '../audio/fileTempo';

const DEFAULT_BPM = 120;
const DEFAULT_SAMPLE_RATE = 44100;

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(source: Record<string, unknown> | null, key: string): string[] {
  const value = source?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
}

export function buildProjectModel(selectionPath: string): ProjectModel {
  const warnings: string[] = [];
  const paths = resolveLogicPaths(selectionPath);
  if (!paths.projectDataPath) {
    throw new Error(`No ProjectData found in ${paths.projectName}. Open and save the project in Logic first.`);
  }
  const buffer = readLogicImage(paths.projectDataPath);
  const metadata = paths.metadataPath ? readPlistJson(paths.metadataPath) : null;

  const baseBpm = readNumber(metadata, 'BeatsPerMinute') ?? DEFAULT_BPM;
  if (!readNumber(metadata, 'BeatsPerMinute')) {
    warnings.push(`MetaData.plist had no tempo; assuming ${DEFAULT_BPM} BPM.`);
  }
  const sampleRate = readNumber(metadata, 'SampleRate') ?? DEFAULT_SAMPLE_RATE;

  // ---- timebase ----------------------------------------------------------
  let tempoEvents: TempoEvent[] = [];
  try {
    const selection = selectTempoEvents(findTempoLists(buffer));
    tempoEvents = selection.events;
    if (selection.rejected > 0) {
      warnings.push(`Ignored ${selection.rejected} implausible tempo record(s) from the 0x60 scan.`);
    }
  } catch (error) {
    warnings.push(`Tempo map unreadable: ${(error as Error).message}`);
  }
  const tempoMap = buildTempoMap(tempoEvents, baseBpm);

  const timeSignatures: TimeSignature[] = [];
  try {
    for (const list of findSignatureLists(buffer)) {
      for (const record of list.meterRecords) {
        timeSignatures.push({
          // The vendored reader does not expose per-record positions, so every
          // meter is anchored at beat 0 for now; a meter CHANGE mid-project is
          // therefore not yet represented. Tracked as a known gap.
          beat: 0,
          numerator: record.numerator,
          denominator: record.denominator,
        });
      }
    }
  } catch (error) {
    warnings.push(`Time signatures unreadable: ${(error as Error).message}`);
  }
  if (timeSignatures.length > 1) {
    warnings.push('Meter changes are not positioned yet; using the first signature throughout.');
    timeSignatures.length = 1;
  }

  // ---- tracks ------------------------------------------------------------
  const namesByRef = resolveTrackNamesByRef(buffer);
  const channelNamesByRef = resolveTrackChannelNamesByRef(buffer);
  const channelsByRef = resolveTrackChannelsByRef(buffer);
  const tracks: TrackModel[] = [];
  const trackIdByRef = new Map<number, string>();
  /** `${stripRef}#${number}` -> id, for tracks that share a strip. */
  const trackIdByKey = new Map<string, string>();

  const channelFor = (refKey: string): ChannelModel | null => {
    const info = channelsByRef.get(refKey);
    return info ? { name: info.name, kind: info.kind, outputBus: info.outputBus, inputBus: info.inputBus } : null;
  };
  const newTrack = (ref: number, name: string, arrangeIndex: number): TrackModel => ({
    id: `t${ref}`,
    arrangeIndex,
    name,
    kind: 'unknown',
    color: fallbackTrackColor(tracks.length, 'unknown'),
    colorSource: 'fallback',
    trackRef: ref,
    muted: channelsByRef.get(`0x${ref.toString(16)}`)?.muted ?? false,
    mutedBy: null,
    volume: null,
    ownVolume: null,
    number: null,
    depth: 0,
    parentId: null,
    stack: null,
    channel: channelFor(`0x${ref.toString(16)}`),
  });

  const strips = listTrackStrips(buffer);
  const arrangeTree = readArrangeTree(buffer);
  if (arrangeTree) {
    // The song-root folder lists exactly the tracks Logic shows, in its order,
    // with stack nesting. Strips it does not list (Stereo Out, Master, aux
    // strips with no arrange track) are not tracks.
    const stripByRef = new Map<number, TrackStrip>();
    for (const strip of strips) if (!stripByRef.has(strip.ref)) stripByRef.set(strip.ref, strip);
    for (const node of arrangeTree) {
      const strip = stripByRef.get(node.stripRef);
      const refKey = `0x${node.stripRef.toString(16)}`;
      const name = strip?.exactName
        || strip?.name
        || namesByRef.get(refKey)
        || channelNamesByRef.get(refKey)
        || `Track ${node.number}`;
      const track = newTrack(node.stripRef, name, node.number - 1);
      // Two tracks can share one channel strip (dark.logicx's 2 and 3; the
      // second has node type 5). Placements name their track by number as
      // well as strip, so the later one gets its own id and trackIdFor finds it.
      if (trackIdByRef.has(node.stripRef)) track.id = `t${node.stripRef}.${node.number}`;
      trackIdByKey.set(`${node.stripRef}#${node.number}`, track.id);
      track.number = node.number;
      track.depth = node.depth;
      track.parentId = node.parentRef === null ? null : `t${node.parentRef}`;
      if (node.stackHead) {
        track.stack = { summing: track.channel?.kind === 'aux', expanded: node.expanded };
      }
      if (!trackIdByRef.has(node.stripRef)) trackIdByRef.set(node.stripRef, track.id);
      tracks.push(track);
    }
  } else {
    // Arrange ordinals come from the object-registry walk when it succeeds; it
    // refuses some real projects outright, so the ivnE strip scan is the source
    // of truth for WHICH tracks exist and the registry only refines the order.
    const ordinalByRef = new Map<number, number>();
    try {
      for (const listed of listLogicTracks(buffer)) {
        ordinalByRef.set(listed.strip_ref, listed.arrange_ordinal);
      }
    } catch {
      warnings.push('Track order unavailable; falling back to track-strip order in the file.');
    }
    for (const strip of strips) {
      const name = strip.name
        || namesByRef.get(strip.refKey)
        || channelNamesByRef.get(strip.refKey);
      if (!name) continue;
      if (trackIdByRef.has(strip.ref)) continue;
      // Unlisted strips go after every listed track, in file order. Using the
      // running count as their index collided with real ordinals and put
      // Stereo Out and Master among the first tracks.
      const track = newTrack(strip.ref, name, ordinalByRef.get(strip.ref) ?? ordinalByRef.size + tracks.length);
      trackIdByRef.set(strip.ref, track.id);
      tracks.push(track);
    }
  }
  tracks.sort((a, b) => a.arrangeIndex - b.arrangeIndex);
  tracks.forEach((track, index) => { track.arrangeIndex = index; });

  function trackIdFor(trackRef: number, trackNumber: number): string {
    const existing = trackIdByKey.get(`${trackRef}#${trackNumber}`) ?? trackIdByRef.get(trackRef);
    if (existing) return existing;
    const id = `t${trackRef}`;
    if (!tracks.some((t) => t.id === id)) {
      trackIdByRef.set(trackRef, id);
      tracks.push(newTrack(trackRef, namesByRef.get(`0x${trackRef.toString(16)}`) ?? `Track ${tracks.length + 1}`, tracks.length));
    }
    return id;
  }

  // Bound the track number by what this project actually has, so a stray
  // marker byte in unrelated data cannot invent a region on a track that does
  // not exist.
  const maxTrackNumber = Math.max(8, tracks.length + 4);

  // ---- MIDI regions ------------------------------------------------------
  const regions: RegionModel[] = [];
  let midiRegionCount = 0;
  for (const parsed of parseMidiRegions(buffer, maxTrackNumber)) {
    if (parsed.notes.length === 0) continue; // empty cells and pool entries
    midiRegionCount += 1;
    const trackId = trackIdFor(parsed.trackRef, parsed.trackNumber);
    const track = tracks.find((t) => t.id === trackId);
    if (track) track.kind = 'midi';

    const notes = new Int32Array(parsed.notes.length * NOTE_STRIDE);
    let pitchMin = 127;
    let pitchMax = 0;
    for (let i = 0; i < parsed.notes.length; i += 1) {
      const note = parsed.notes[i];
      if (!note) continue;
      // Draw what the bounce plays: region Transpose shifts pitch at playback
      // and leaves the stored notes alone.
      const pitch = Math.max(0, Math.min(127, note.pitch + parsed.transpose));
      notes[i * NOTE_STRIDE] = note.startTicks;
      notes[i * NOTE_STRIDE + 1] = note.durationTicks;
      notes[i * NOTE_STRIDE + 2] = pitch;
      notes[i * NOTE_STRIDE + 3] = note.velocity;
      if (pitch < pitchMin) pitchMin = pitch;
      if (pitch > pitchMax) pitchMax = pitch;
    }
    const startBeat = parsed.positionTicks / 960;
    const lengthBeats = parsed.lengthTicks / 960;
    const region: MidiRegionModel = {
      kind: 'midi',
      id: `m:${shortHash(`${parsed.trackRef}:${parsed.positionTicks}:${parsed.name}`)}`,
      trackId,
      name: parsed.name,
      startBeat,
      lengthBeats,
      startSeconds: beatsToSeconds(tempoMap, startBeat),
      endSeconds: beatsToSeconds(tempoMap, startBeat + lengthBeats),
      notes,
      noteCount: parsed.notes.length,
      pitchMin: pitchMin <= pitchMax ? pitchMin : 60,
      pitchMax: pitchMax >= pitchMin ? pitchMax : 72,
      transposeSemitones: parsed.transpose,
      muted: parsed.muted,
    };
    regions.push(region);
  }

  // ---- audio files + regions --------------------------------------------
  const metaAudioPaths = [
    ...readStringArray(metadata, 'AudioFiles'),
    ...readStringArray(metadata, 'UnusedAudioFiles'),
  ];
  const relativeByBasename = new Map<string, string>();
  for (const relative of metaAudioPaths) {
    relativeByBasename.set(path.basename(relative), relative);
  }

  const audioFiles: AudioFileModel[] = [];
  const audioFileIdByOid = new Map<number, string>();
  for (const file of parseAudioFiles(buffer)) {
    const relative = relativeByBasename.get(file.fileName) ?? null;
    const absolute = relative && paths.mediaPath ? path.join(paths.mediaPath, relative) : null;
    const id = `a${file.oid}`;
    audioFileIdByOid.set(file.oid, id);
    audioFiles.push({
      id,
      fileName: file.fileName,
      relativePath: relative,
      absolutePath: absolute,
      exists: absolute ? fs.existsSync(absolute) : false,
    });
  }

  // Audio regions. Position and track come from the arrangement units; length,
  // trim-in and the source file come from the joined region definition. The
  // file is resolved by POINTER (AuRg +10 is the file's oid), never by name:
  // name matching picked the wrong file for 102 regions across ~/Music/Logic,
  // where a take suffix like "X.10" collided with a separate "X.1.wav" -- and
  // drew a waveform from a file of a different length, which ran out partway.
  const placed = placedAudioRegions(buffer, maxTrackNumber);

  // Flex regions are stretched to follow project tempo. Their stretched length is
  // stored in a time map after the placement (flexTimelineTicks); for the few
  // without one it is estimated from the audio file's own tempo, read once per file.
  const absolutePathByFileId = new Map(audioFiles.map((file) => [file.id, file.absolutePath]));
  const tempoByFileId = new Map<string, number | null>();
  function fileTempo(fileId: string | null): number | null {
    if (!fileId) return null;
    if (!tempoByFileId.has(fileId)) {
      const filePath = absolutePathByFileId.get(fileId);
      tempoByFileId.set(fileId, filePath ? readFileTempo(filePath) : null);
    }
    return tempoByFileId.get(fileId) ?? null;
  }
  let stretchedCount = 0;
  let flexUnresolved = 0;

  for (const region of placed) {
    const trackId = trackIdFor(region.trackRef, region.trackNumber);
    const track = tracks.find((t) => t.id === trackId);
    if (track && track.kind === 'unknown') track.kind = 'audio';

    const startBeat = region.positionTicks / LOGIC_PPQ;
    const startSeconds = beatsToSeconds(tempoMap, startBeat);
    const audioFileId = audioFileIdByOid.get(region.fileOid) ?? null;
    const nativeSeconds = region.lengthSamples / sampleRate;

    // Unstretched: the timeline length IS the audio length. Flexed: Logic's own
    // time map gives the length in ticks, and the audio is squeezed or
    // stretched to fit. Without one, the audio is taken to hold a whole number
    // of beats at its file's tempo; with no file tempo either, it stays native.
    let endSecondsForRegion = startSeconds + nativeSeconds;
    let sourceRate = 1;
    if (region.flex) {
      const tempo = region.timelineTicks === null ? fileTempo(audioFileId) : null;
      const beats = region.timelineTicks !== null
        ? region.timelineTicks / LOGIC_PPQ
        : tempo !== null ? flexedBeats(nativeSeconds, tempo) : null;
      if (beats !== null) {
        endSecondsForRegion = beatsToSeconds(tempoMap, startBeat + beats);
        const timelineSeconds = endSecondsForRegion - startSeconds;
        if (timelineSeconds > 0) sourceRate = nativeSeconds / timelineSeconds;
        stretchedCount += 1;
      } else {
        flexUnresolved += 1;
      }
    }

    regions.push({
      kind: 'audio',
      id: `a:${shortHash(`${region.trackRef}:${region.positionTicks}:${region.name}`)}`,
      trackId,
      name: region.name,
      startBeat,
      // Audio length is sample-accurate, so its beat span is derived rather
      // than stored, and is only exact under constant tempo.
      lengthBeats: secondsToBeats(tempoMap, endSecondsForRegion) - startBeat,
      startSeconds,
      endSeconds: endSecondsForRegion,
      audioFileId,
      // Trim-in is decoded (AuRg +42, re_probe7) and exact for every trimmed
      // region in ~/Music/Logic, all of which use files at the project's sample
      // rate. For a file at a DIFFERENT rate it is unverified whether Logic
      // counts these samples at the file's rate or the project's; this assumes
      // the project's.
      fileStartSeconds: region.fileStartSamples / sampleRate,
      gainDb: region.gainDb,
      flex: region.flex,
      reversed: region.reversed,
      transposeSemitones: region.transpose,
      muted: region.muted,
      // A fade cannot outlast its region; the dozen in the corpus that claim
      // to are clamped rather than trusted.
      fadeInSeconds: Math.min(region.fadeInMs / 1000, endSecondsForRegion - startSeconds),
      fadeOutSeconds: Math.min(region.fadeOutMs / 1000, endSecondsForRegion - startSeconds),
      fadeInCurve: Math.max(-1, Math.min(1, region.fadeInCurve / 99)),
      fadeOutCurve: Math.max(-1, Math.min(1, region.fadeOutCurve / 99)),
      sourceRate,
      lengthApproximate: false,
    });
  }
  if (stretchedCount > 0 || flexUnresolved > 0) {
    warnings.push(
      `Flex: ${stretchedCount} stretched`
      + (flexUnresolved > 0 ? `, ${flexUnresolved} at native length (no file tempo)` : ''),
    );
  }

  // ---- volume automation -------------------------------------------------
  // Per strip, not per track: an aux with no arrange track can still carry the
  // automation or the mute that its inputs are heard through.
  const ownVolumeByRef = new Map<number, VolumeCurve>();
  try {
    for (const [ref, points] of parseTrackVolumeAutomation(buffer)) {
      if (points.length === 0) continue;
      const seconds = new Float64Array(points.length);
      const fader = new Float32Array(points.length);
      points.forEach((point, i) => {
        seconds[i] = beatsToSeconds(tempoMap, point.positionTicks / LOGIC_PPQ);
        fader[i] = point.value;
      });
      ownVolumeByRef.set(ref, { seconds, fader });
    }
  } catch (error) {
    warnings.push(`Volume automation unreadable: ${(error as Error).message}`);
  }

  // ---- what each track is heard through ----------------------------------
  // A channel is heard through every Aux its output feeds, hop by hop to Stereo
  // Out: a summing stack's members through its main track, a reverb return
  // through whatever it outputs to. Following the ROUTING rather than stack
  // membership matters: djpubichair's "Soft Cinematic" sits in the lead stack
  // but outputs to Stereo Out, so muting "lead" does not silence it. A track
  // whose channel is unknown falls back to its stack's main track.
  const auxRefByBus = new Map<number, number>();
  for (const strip of strips) {
    const channel = channelsByRef.get(strip.refKey);
    if (channel?.kind === 'aux' && channel.inputBus !== null && !auxRefByBus.has(channel.inputBus)) {
      auxRefByBus.set(channel.inputBus, strip.ref);
    }
  }
  const parentRefByRef = new Map<number, number>();
  for (const node of arrangeTree ?? []) {
    if (node.parentRef !== null && !parentRefByRef.has(node.stripRef)) parentRefByRef.set(node.stripRef, node.parentRef);
  }
  const downstream = (ref: number): number[] => {
    const chain: number[] = [];
    const seen = new Set([ref]);
    let at = ref;
    for (;;) {
      const channel = channelsByRef.get(`0x${at.toString(16)}`);
      const next = channel
        ? (channel.outputBus === null ? undefined : auxRefByBus.get(channel.outputBus))
        : parentRefByRef.get(at);
      if (next === undefined || seen.has(next)) return chain;
      seen.add(next);
      chain.push(next);
      at = next;
    }
  };
  const trackIdByStrip = new Map<number, string>();
  for (const track of tracks) if (!trackIdByStrip.has(track.trackRef)) trackIdByStrip.set(track.trackRef, track.id);
  for (const track of tracks) {
    const path = [track.trackRef, ...downstream(track.trackRef)];
    const silencer = path.find((ref) => channelsByRef.get(`0x${ref.toString(16)}`)?.muted);
    track.muted = silencer !== undefined;
    track.mutedBy = silencer === undefined ? null : trackIdByStrip.get(silencer) ?? null;
    track.ownVolume = ownVolumeByRef.get(track.trackRef) ?? null;
    track.volume = combineVolumeCurves(path.flatMap((ref) => ownVolumeByRef.get(ref) ?? []));
  }

  // ---- markers -----------------------------------------------------------
  const markers: MarkerModel[] = [];
  try {
    for (const marker of listTrackMarkers(buffer, metadata)) {
      const beat = ticksToBeats(marker.positionTicks, 'absolute');
      markers.push({
        id: `mk:${shortHash(`${marker.positionTicks}:${marker.name}`)}`,
        name: marker.name,
        startBeat: beat,
        startSeconds: beatsToSeconds(tempoMap, beat),
      });
    }
  } catch {
    // Projects with no marker track have no marker list; that is not an error.
  }

  regions.sort((a, b) => a.startSeconds - b.startSeconds);
  const endSeconds = regions.reduce((max, r) => Math.max(max, r.endSeconds), 0);

  return {
    schemaVersion: 1,
    projectPath: paths.projectPath,
    projectName: paths.projectName,
    alternativeId: paths.alternativeId,
    projectDataPath: paths.projectDataPath,
    windowImagePath: paths.windowImagePath,
    parsedAt: Date.now(),
    sourceMtimeMs: fs.statSync(paths.projectDataPath).mtimeMs,
    baseBpm,
    sampleRate,
    songKey: readString(metadata, 'SongKey'),
    songScale: (() => {
      const scale = readString(metadata, 'SongGenderKey')?.toLowerCase();
      return scale === 'major' || scale === 'minor' ? scale : null;
    })(),
    tempoEvents,
    timeSignatures,
    tracks,
    regions,
    audioFiles,
    markers,
    endSeconds,
    capabilities: {
      midiRegions: midiRegionCount > 0,
      audioRegions: placed.length > 0,
      audioRegionTracks: placed.length > 0,
      trackColors: false,
      tempoMap: tempoEvents.length > 0,
      timeSignatureMap: timeSignatures.length > 0,
    },
    warnings,
  };
}
