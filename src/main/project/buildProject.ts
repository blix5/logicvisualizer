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
import {
  resolveTrackNamesByRef,
  resolveTrackChannelNamesByRef,
  resolveTrackChannelsByRef,
  listTrackStrips,
} from '../logic/trackNames';
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
  MarkerModel,
  MidiRegionModel,
  ProjectModel,
  RegionModel,
  TrackModel,
} from '../../shared/model';
import { NOTE_STRIDE } from '../../shared/model';
import { fallbackTrackColor } from './palette';

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

  for (const strip of listTrackStrips(buffer)) {
    const name = strip.name
      || namesByRef.get(strip.refKey)
      || channelNamesByRef.get(strip.refKey);
    if (!name) continue;
    const id = `t${strip.ref}`;
    if (trackIdByRef.has(strip.ref)) continue;
    trackIdByRef.set(strip.ref, id);
    tracks.push({
      id,
      arrangeIndex: ordinalByRef.get(strip.ref) ?? tracks.length,
      name,
      kind: 'unknown',
      color: fallbackTrackColor(tracks.length, 'unknown'),
      colorSource: 'fallback',
      trackRef: strip.ref,
      muted: channelsByRef.get(strip.refKey)?.muted ?? false,
    });
  }
  tracks.sort((a, b) => a.arrangeIndex - b.arrangeIndex);
  tracks.forEach((track, index) => { track.arrangeIndex = index; });

  function trackIdFor(trackRef: number, fallbackIndex: number): string {
    const existing = trackIdByRef.get(trackRef);
    if (existing) return existing;
    const id = `t${trackRef}`;
    if (!tracks.some((t) => t.id === id)) {
      trackIdByRef.set(trackRef, id);
      tracks.push({
        id,
        arrangeIndex: tracks.length,
        name: namesByRef.get(`0x${trackRef.toString(16)}`) ?? `Track ${tracks.length + 1}`,
        kind: 'unknown',
        color: fallbackTrackColor(tracks.length, 'unknown'),
        colorSource: 'fallback',
        trackRef,
        muted: channelsByRef.get(`0x${trackRef.toString(16)}`)?.muted ?? false,
      });
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
    const trackId = trackIdFor(parsed.trackRef, parsed.trackNumber - 1);
    const track = tracks.find((t) => t.id === trackId);
    if (track) track.kind = 'midi';

    const notes = new Int32Array(parsed.notes.length * NOTE_STRIDE);
    let pitchMin = 127;
    let pitchMax = 0;
    for (let i = 0; i < parsed.notes.length; i += 1) {
      const note = parsed.notes[i];
      if (!note) continue;
      notes[i * NOTE_STRIDE] = note.startTicks;
      notes[i * NOTE_STRIDE + 1] = note.durationTicks;
      notes[i * NOTE_STRIDE + 2] = note.pitch;
      notes[i * NOTE_STRIDE + 3] = note.velocity;
      if (note.pitch < pitchMin) pitchMin = note.pitch;
      if (note.pitch > pitchMax) pitchMax = note.pitch;
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

  // Audio regions. Position and track come from the arrangement units, length
  // from the joined region definition. The source file is resolved by name,
  // since a region's name is its file's basename plus an optional take suffix.
  const filesByBasename = new Map<string, AudioFileModel>();
  for (const file of audioFiles) {
    const base = file.fileName.replace(/\.[a-z0-9]+$/i, '');
    if (!filesByBasename.has(base)) filesByBasename.set(base, file);
  }

  /**
   * A region's name is its file's basename plus, usually, a take suffix. Two
   * transforms cover the rest: Logic strips the take number before a stem
   * qualifier, and writes stem qualifiers parenthesised where the file on disk
   * uses an underscore ("blue (Vocals)" against blue_Vocals.wav).
   */
  function resolveAudioFile(regionName: string): AudioFileModel | null {
    const withoutTake = regionName.replace(/\.\d+(?=\s*\(|$)/, '');
    const candidates = [
      regionName,
      withoutTake,
      withoutTake.replace(/\s*\(([^)]+)\)\s*$/, '_$1'),
    ];
    for (const candidate of candidates) {
      const match = filesByBasename.get(candidate);
      if (match) return match;
    }
    return null;
  }
  const placed = placedAudioRegions(buffer, maxTrackNumber);

  for (const region of placed) {
    const trackId = trackIdFor(region.trackRef, region.trackNumber - 1);
    const track = tracks.find((t) => t.id === trackId);
    if (track && track.kind === 'unknown') track.kind = 'audio';

    const startBeat = region.positionTicks / LOGIC_PPQ;
    const startSeconds = beatsToSeconds(tempoMap, startBeat);
    const endSecondsForRegion = startSeconds + region.lengthSamples / sampleRate;

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
      audioFileId: resolveAudioFile(region.name)?.id ?? null,
      fileStartSeconds: region.fileStartSamples / sampleRate,
      gainDb: region.gainDb,
      lengthApproximate: false,
    });
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
